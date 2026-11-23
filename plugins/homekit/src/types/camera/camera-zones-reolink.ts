import type { ScryptedDevice, Setting, Settings, Storage } from '@scrypted/sdk';
import type { SecureVideoController } from '../../hap';

/**
 * Home's activity zones -> the Reolink camera's own motion detection area.
 *
 * The cameras only report "motion yes/no", so zones cannot be applied to motion
 * events in Scrypted. Instead the union of the zones is rasterised onto the
 * camera's motion grid (GetMdAlarm/SetMdAlarm, or GetAlarm/SetAlarm on older
 * firmware), so the camera itself ignores motion outside them. The camera's own
 * area is saved before the first write and restored when zones are turned off.
 */

interface ZoneValue {
    method: number;
    polygons: { vertices: { x: number, y: number }[] }[];
}

interface Scope { cols: number; rows: number; table: string; }

const ORIGINAL_KEY = 'hksv3ReolinkMotionAreaOriginal';
const APPLIED_KEY = 'hksv3ReolinkMotionAreaApplied';

/** Vertex coordinates are UINT16 per Apple's spec; the full range spans the image. */
export const ZONE_COORDINATE_MAX = 65535;
/** Writing is enabled once the coordinate range has been confirmed against a real zone from Home. */
export const ZONE_APPLY = false;

function insidePolygon(x: number, y: number, vertices: { x: number, y: number }[]) {
    let inside = false;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
        const a = vertices[i], b = vertices[j];
        if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x)
            inside = !inside;
    }
    return inside;
}

/** Rasterise zones onto a cols x rows grid ('1' = detect), sampling each cell's centre. */
export function zonesToTable(zones: ZoneValue[], cols: number, rows: number, max = ZONE_COORDINATE_MAX): string {
    let table = '';
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const x = (col + 0.5) / cols * max;
            const y = (row + 0.5) / rows * max;
            let detect = false;
            for (const zone of zones) {
                const inAny = zone.polygons.some(polygon => polygon.vertices.length >= 3 && insidePolygon(x, y, polygon.vertices));
                // method 2 (inverted): the region of interest is outside every polygon
                if (zone.method === 2 ? !inAny : inAny)
                    detect = true;
            }
            table += detect ? '1' : '0';
        }
    }
    return table;
}

class ReolinkMotionArea {
    private token?: string;

    constructor(private base: string, private username: string, private password: string, private console: Console) { }

    private async call(cmd: string, param: any, action = 0): Promise<any> {
        if (!this.token && cmd !== 'Login')
            await this.login();
        const url = `${this.base}/api.cgi?cmd=${cmd}${this.token ? `&token=${this.token}` : ''}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([{ cmd, action, param }]),
            signal: AbortSignal.timeout(10000),
        });
        const [result] = await response.json() as any[];
        if (result?.code !== 0)
            throw new Error(`${cmd} failed: ${result?.error?.detail || result?.error?.rspCode || response.status}`);
        return result.value;
    }

    private async login() {
        const value = await this.call('Login', { User: { Version: '0', userName: this.username, password: this.password } });
        this.token = value?.Token?.name;
        if (!this.token)
            throw new Error('Login returned no token');
    }

    async logout() {
        if (this.token)
            await this.call('Logout', {}).catch(() => { });
        this.token = undefined;
    }

    /** Returns the camera's motion settings object and which command family it uses. */
    async read(): Promise<{ kind: 'MdAlarm' | 'Alarm', value: any, scope: Scope }> {
        try {
            const value = await this.call('GetMdAlarm', { channel: 0 });
            if (value?.MdAlarm?.scope?.table)
                return { kind: 'MdAlarm', value: value.MdAlarm, scope: value.MdAlarm.scope };
        }
        catch (e) {
            this.console.log('HKSV3 zones: GetMdAlarm unavailable, trying GetAlarm:', (e as Error).message);
        }
        const value = await this.call('GetAlarm', { Alarm: { channel: 0, type: 'md' } });
        if (!value?.Alarm?.scope?.table)
            throw new Error('camera returned no motion area');
        return { kind: 'Alarm', value: value.Alarm, scope: value.Alarm.scope };
    }

    async write(kind: 'MdAlarm' | 'Alarm', value: any, table: string) {
        const updated = { ...value, scope: { ...value.scope, table } };
        await this.call(kind === 'MdAlarm' ? 'SetMdAlarm' : 'SetAlarm', { [kind]: updated });
    }
}

function settingValue(settings: Setting[], key: string) {
    return settings.find(setting => setting.key === key || setting.key?.endsWith(':' + key))?.value as string | undefined;
}

async function connect(device: ScryptedDevice, console: Console) {
    if (device.pluginId !== '@scrypted/reolink')
        return undefined;
    const settings = await (device as ScryptedDevice & Settings).getSettings();
    const ip = settingValue(settings, 'ip');
    const username = settingValue(settings, 'username');
    const password = settingValue(settings, 'password');
    const port = settingValue(settings, 'httpPort') || '80';
    if (!ip || !username)
        return undefined;
    return new ReolinkMotionArea(`http://${ip}:${port}`, username, password || '', console);
}

function describeZones(zones?: { zones: ZoneValue[] }) {
    if (!zones?.zones?.length)
        return 'none';
    const vertices = zones.zones.flatMap(zone => zone.polygons.flatMap(polygon => polygon.vertices));
    const xs = vertices.map(v => v.x), ys = vertices.map(v => v.y);
    return `${zones.zones.length} zone(s), methods ${zones.zones.map(zone => zone.method).join('/')}, `
        + `${zones.zones.reduce((n, zone) => n + zone.polygons.length, 0)} polygon(s), x ${Math.min(...xs)}..${Math.max(...xs)}, y ${Math.min(...ys)}..${Math.max(...ys)}`;
}

export function syncReolinkZones(device: ScryptedDevice, controller: SecureVideoController, storage: Storage, console: Console) {
    let running = Promise.resolve();

    const sync = async () => {
        const { active, zones } = controller.motionZones as { active: boolean, zones?: { zones: ZoneValue[] } };
        console.log(`HKSV3 zones from Home: ${active ? 'active' : 'inactive'}, ${describeZones(zones)}`);
        const camera = await connect(device, console);
        if (!camera)
            return;
        try {
            const { kind, value, scope } = await camera.read();
            const on = scope.table.split('').filter(c => c === '1').length;
            console.log(`HKSV3 zones: camera motion area ${kind} ${scope.cols}x${scope.rows}, ${on}/${scope.table.length} cells detecting`);

            const original = storage.getItem(ORIGINAL_KEY);
            const wanted = active && zones?.zones?.length
                ? zonesToTable(zones.zones, scope.cols, scope.rows)
                : original ?? undefined;
            if (!wanted || wanted === scope.table || wanted.length !== scope.table.length)
                return;
            if (!ZONE_APPLY) {
                console.log(`HKSV3 zones: would set ${wanted.split('').filter(c => c === '1').length} cells detecting (writing disabled until the coordinate range is confirmed)`);
                return;
            }
            if (!original && active)
                storage.setItem(ORIGINAL_KEY, scope.table);
            await camera.write(kind, value, wanted);
            if (active)
                storage.setItem(APPLIED_KEY, wanted);
            else {
                storage.removeItem(ORIGINAL_KEY);
                storage.removeItem(APPLIED_KEY);
            }
            console.log(`HKSV3 zones: camera motion area ${active ? 'set from Home zones' : 'restored'}, ${wanted.split('').filter(c => c === '1').length} cells detecting`);
        }
        catch (e) {
            console.log('HKSV3 zones: camera update failed:', (e as Error).message);
        }
        finally {
            await camera.logout();
        }
    };

    const schedule = () => { running = running.then(sync, sync); };
    controller.on('zones-changed' as any, schedule);
    // startup: report what Home has and what the camera uses (read only unless zones differ)
    setTimeout(schedule, 15000);
}
