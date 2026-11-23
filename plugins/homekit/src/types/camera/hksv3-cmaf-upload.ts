import http2 from 'http2';
import { mp4FirstTfdt, mp4RebaseTfdt, mp4SegmentDuration, mp4SegmentTrackIds, mp4StripTrack, mp4TrackInfo } from './hksv3-mp4';

// HKSV3 CMAF clip upload, replacing the bundled HAP CMAFIngest.
//
// What the hub and Apple's ingest accepted in testing (HTTP 201 for every PUT,
// clip plays with audio in the Home app):
// - unencrypted fragmented MP4, audio and video muxed in ONE rendition named "video"
//   (separate audio/video renditions and AES-GCM wrapped files played black or got HTTP 400)
// - a master playlist with the sensor id as EXT-X-SESSION-DATA, then the media playlist
// - upload order: master, media playlist (open), init, segments, media playlist (closed)
// - a User-Agent on every request and an x-extinf-duration header on each segment PUT
// - tfdt rebased to zero for the clip
// - an audio track with no samples is removed from the init segment
//   (an empty audio track makes the clip unplayable)
// - clip/session numbers increase per publishing point and survive restarts

export interface CMAFUploadCommand {
    sessionId: bigint;
    command: number;
}

export interface CMAFUploadContext {
    sensorUUID: string;
    credentials(): {
        publishingPoint?: { url: string; serverCACertificates: Buffer[] };
        privateKey?: Buffer | string;
        clientCertificate?: Buffer;
        ca?: Buffer;
    };
    reportSessionStart(id: bigint): void;
    reportSessionStop(id: bigint, detail?: string): void;
    reportError(id: bigint, error: number, detail?: string): void;
}

export interface CMAFClipSource {
    streamClip(request: { cmafSessionId: bigint; command: CMAFUploadCommand; signal: AbortSignal }):
        AsyncGenerator<{ type: 'init' | 'media'; data: Buffer; last?: boolean }>;
}

export interface CMAFUploadState {
    load(): { url?: string; next?: number } | undefined;
    save(state: { url: string; next: number }): void;
}

// HAP command values: 2 = finalize, 3 = stop.
const COMMAND_FINALIZE = 2;
const COMMAND_STOP = 3;
// HKSV upload error codes reported back to the hub.
const ERROR_NOT_PROVISIONED = 5;
const ERROR_CLIP = 11;
const MAX_CLIP_SECONDS = 290;

function toPem(der: Buffer) {
    return `-----BEGIN CERTIFICATE-----\n${Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
}

function mapStatus(status: number) {
    if (status === 400) return 15;
    if (status === 401 || status === 403) return 16;
    if (status === 404) return 19;
    if (status === 412) return 20;
    if (status === 415) return 21;
    if (status === 503) return 25;
    if (status >= 500) return 24;
    return 1;
}

interface UploadSession {
    clipId: bigint;
    abort: AbortController;
    stop: boolean;
    finished: boolean;
}

export class HKSV3CMAFUploader {
    sessions = new Map<bigint, UploadSession>();

    constructor(public source: CMAFClipSource, public context: CMAFUploadContext, public state: CMAFUploadState,
        public userAgent: string, public console: Console) {
    }

    nextClipNumber() {
        const url = this.context.credentials()?.publishingPoint?.url || '';
        let saved: ReturnType<CMAFUploadState['load']>;
        try {
            saved = this.state.load();
        }
        catch {
        }
        const next = saved?.url === url && typeof saved.next === 'number' ? saved.next : 1;
        this.state.save({ url, next: next + 1 });
        return BigInt(next);
    }

    handleUploadCommand(command: CMAFUploadCommand) {
        const existing = this.sessions.get(command.sessionId);
        if (command.command === COMMAND_STOP) {
            if (!existing) {
                this.console.log('HKSV3 upload stop for unknown session', command.sessionId.toString());
                return 0n;
            }
            existing.stop = true;
            if (existing.finished)
                this.sessions.delete(command.sessionId);
            return existing.clipId;
        }
        if (existing)
            return existing.clipId;
        const session: UploadSession = { clipId: this.nextClipNumber(), abort: new AbortController(), stop: false, finished: false };
        this.sessions.set(command.sessionId, session);
        this.upload(command, session)
            .catch(e => this.console.error('HKSV3 upload crashed', e))
            .finally(() => {
                session.finished = true;
                if (command.command === COMMAND_FINALIZE || session.stop)
                    this.sessions.delete(command.sessionId);
            });
        return session.clipId;
    }

    destroy() {
        for (const session of this.sessions.values())
            session.abort.abort();
        this.sessions.clear();
    }

    async upload(command: CMAFUploadCommand, session: UploadSession) {
        const credentials = this.context.credentials();
        const n = session.clipId;
        if (!credentials?.publishingPoint || !credentials.privateKey || !credentials.clientCertificate) {
            this.console.log('HKSV3 upload: recording ingest is not provisioned');
            this.context.reportError(n, ERROR_NOT_PROVISIONED);
            return;
        }

        const url = new URL(credentials.publishingPoint.url);
        const base = `${url.pathname.endsWith('/') ? url.pathname : url.pathname + '/'}session_${n}/`;
        const client = http2.connect(url.origin, {
            key: credentials.privateKey,
            cert: toPem(credentials.clientCertificate) + (credentials.ca ? toPem(credentials.ca) : ''),
            ca: credentials.publishingPoint.serverCACertificates.map(toPem),
        });
        client.on('error', e => this.console.log('HKSV3 upload http2 error', e.message));

        const put = (path: string, body: Buffer, contentType: string, headers: Record<string, string> = {}) => new Promise<number>((resolve, reject) => {
            const request = client.request({
                ':method': 'PUT',
                ':path': base + path,
                'content-type': contentType,
                'content-length': body.length,
                'user-agent': this.userAgent,
                ...headers,
            });
            let status = 0;
            const response: Buffer[] = [];
            request.on('response', h => status = Number(h[':status']));
            request.on('data', d => response.push(d));
            request.on('end', () => {
                if (status < 200 || status >= 300)
                    this.console.log('HKSV3 upload PUT', path, body.length, '->', status, Buffer.concat(response).toString().slice(0, 300));
                resolve(status);
            });
            request.on('error', reject);
            request.end(body);
        });
        const ok = async (path: string, body: Buffer, contentType: string, headers?: Record<string, string>) => {
            const status = await put(path, body, contentType, headers);
            if (status >= 200 && status < 300)
                return true;
            this.context.reportError(n, mapStatus(status), `PUT ${path} -> ${status}`);
            return false;
        };

        const playlistType = 'application/vnd.apple.mpegurl';
        const durations: number[] = [];
        let targetDuration = 0;
        const mediaPlaylist = (final: boolean) => [
            '#EXTM3U',
            '#EXT-X-VERSION:7',
            `#EXT-X-TARGETDURATION:${targetDuration}`,
            '#EXT-X-MEDIA-SEQUENCE:1001',
            '#EXT-X-PLAYLIST-TYPE:EVENT',
            '#EXT-X-INDEPENDENT-SEGMENTS',
            '#EXT-X-MAP:URI="video.init"',
            ...(final ? durations.flatMap((d, i) => [`#EXTINF:${d.toFixed(5)},`, `segment_${1001 + i}.m4s`]).concat(['#EXT-X-ENDLIST']) : []),
            '',
        ].join('\n');

        const clip = this.source.streamClip({ cmafSessionId: command.sessionId, command, signal: session.abort.signal });
        let opened = false;
        let closed = false;
        try {
            const first = await clip.next();
            if (first.done || first.value.type !== 'init')
                throw new Error('no init segment');
            let init = first.value.data;
            const tracks = mp4TrackInfo(init);
            const video = tracks.find(t => t.kind === 'video');
            if (!video)
                throw new Error('init segment without video');
            let audio = tracks.find(t => t.kind === 'audio');
            let codecs = [video.codecs, audio?.codecs].filter(Boolean).join(',');
            let tfdtBase: Record<number, bigint>;

            this.context.reportSessionStart(n);
            this.console.log('HKSV3 upload session', n.toString(), 'start, codecs', codecs, `${video.width}x${video.height}`);

            let index = 0;
            while (true) {
                if (session.stop && index > 0)
                    break;
                const next = await clip.next();
                if (next.done)
                    break;
                if (next.value.type !== 'media')
                    continue;
                let segment = next.value.data;
                const duration = mp4SegmentDuration(segment, video) || 2;

                if (!opened) {
                    targetDuration = Math.ceil(duration) + 1;
                    const withSamples = mp4SegmentTrackIds(segment);
                    if (audio && !withSamples.has(audio.id)) {
                        init = mp4StripTrack(init, audio.id);
                        audio = undefined;
                        codecs = video.codecs;
                        this.console.log('HKSV3 upload session', n.toString(), 'has no audio samples, audio track removed');
                    }
                    tfdtBase = mp4FirstTfdt(segment);
                }
                if (tfdtBase)
                    segment = mp4RebaseTfdt(segment, tfdtBase);

                if (!opened) {
                    const master = [
                        '#EXTM3U',
                        '#EXT-X-VERSION:7',
                        '#EXT-X-INDEPENDENT-SEGMENTS',
                        `#EXT-X-SESSION-DATA:DATA-ID="com.apple.homekit.sensor-id",VALUE="${this.context.sensorUUID}"`,
                        `#EXT-X-STREAM-INF:BANDWIDTH=${Math.ceil(segment.length * 8 / duration * 1.5)},CODECS="${codecs}",RESOLUTION=${video.width}x${video.height}`,
                        'video/index.m3u8',
                        '',
                    ].join('\n');
                    if (!await ok('index.m3u8', Buffer.from(master), playlistType))
                        return;
                    if (!await ok('video/index.m3u8', Buffer.from(mediaPlaylist(false)), playlistType))
                        return;
                    opened = true;
                    if (!await ok('video/video.init', init, 'video/mp4'))
                        return;
                }
                if (!await ok(`video/segment_${1001 + index}.m4s`, segment, 'video/iso.segment', { 'x-extinf-duration': duration.toFixed(5) }))
                    return;
                durations.push(duration);
                index++;
                if (next.value.last)
                    break;
                if (durations.reduce((a, b) => a + b, 0) > MAX_CLIP_SECONDS)
                    break;
            }
            if (opened) {
                await ok('video/index.m3u8', Buffer.from(mediaPlaylist(true)), playlistType);
                closed = true;
            }
            this.context.reportSessionStop(n);
            this.console.log('HKSV3 upload session', n.toString(), 'finished:', index, 'segments,', durations.reduce((a, b) => a + b, 0).toFixed(1), 's');
        }
        catch (e) {
            this.console.log('HKSV3 upload session', n.toString(), 'failed:', e?.message || e);
            this.context.reportError(n, ERROR_CLIP, String(e?.message || e));
        }
        finally {
            if (opened && !closed) {
                try {
                    await put('video/index.m3u8', Buffer.from(mediaPlaylist(true)), playlistType);
                }
                catch {
                }
            }
            try {
                await clip.return?.(undefined);
            }
            catch {
            }
            client.close();
        }
    }
}
