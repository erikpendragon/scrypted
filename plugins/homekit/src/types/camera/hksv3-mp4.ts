// Small fragmented MP4 helpers for the HKSV3 CMAF uploader: track info and codec
// strings from the init segment, per-track sample duration of a media segment,
// tfdt rebasing, and removing a track from the init segment.
// The codec string derivation follows CMAFTracks in HAP-NodeJS PR #1132.

export interface Mp4Box {
    type: string;
    start: number;
    contentStart: number;
    end: number;
}

export interface Mp4TrackInfo {
    id: number;
    kind: 'video' | 'audio';
    timescale: number;
    codecs?: string;
    width?: number;
    height?: number;
    defaultSampleDuration: number;
}

export function mp4Boxes(buffer: Buffer, start = 0, end = buffer.length): Mp4Box[] {
    const result: Mp4Box[] = [];
    let position = start;
    while (position + 8 <= end) {
        let size = buffer.readUInt32BE(position);
        let contentStart = position + 8;
        if (size === 1) {
            size = Number(buffer.readBigUInt64BE(position + 8));
            contentStart += 8;
        }
        else if (size === 0) {
            size = end - position;
        }
        if (size < 8 || position + size > end)
            throw new Error(`truncated ${buffer.toString('latin1', position + 4, position + 8)} box`);
        result.push({
            type: buffer.toString('latin1', position + 4, position + 8),
            start: position,
            contentStart,
            end: position + size,
        });
        position += size;
    }
    return result;
}

function child(buffer: Buffer, parent: Mp4Box, type: string) {
    return mp4Boxes(buffer, parent.contentStart, parent.end).find(box => box.type === type);
}

function makeBox(type: string, ...children: Buffer[]) {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + children.reduce((sum, b) => sum + b.length, 0), 0);
    header.write(type, 4, 'latin1');
    return Buffer.concat([header, ...children]);
}

function tkhdTrackId(buffer: Buffer, trak: Mp4Box) {
    const tkhd = child(buffer, trak, 'tkhd');
    if (!tkhd)
        throw new Error('trak without tkhd');
    return buffer.readUInt32BE(tkhd.contentStart + (buffer[tkhd.contentStart] === 1 ? 20 : 12));
}

function hex(value: number) {
    return value.toString(16).toUpperCase().padStart(2, '0');
}

function reverseBits(value: number) {
    let reversed = 0;
    for (let bit = 0; bit < 32; bit++)
        reversed = (reversed << 1) | ((value >>> bit) & 1);
    return reversed >>> 0;
}

function videoCodecs(buffer: Buffer, entry: Mp4Box) {
    const children = mp4Boxes(buffer, entry.contentStart + 78, entry.end);
    const avcC = children.find(box => box.type === 'avcC');
    if (avcC) {
        const c = avcC.contentStart;
        return `${entry.type}.${hex(buffer[c + 1])}${hex(buffer[c + 2])}${hex(buffer[c + 3])}`.toLowerCase();
    }
    const hvcC = children.find(box => box.type === 'hvcC');
    if (hvcC) {
        const c = hvcC.contentStart;
        const general = buffer[c + 1];
        const space = ['', 'A', 'B', 'C'][general >> 6];
        const tier = general & 0x20 ? 'H' : 'L';
        const compatibility = reverseBits(buffer.readUInt32BE(c + 2)).toString(16).toUpperCase();
        const constraints = [...buffer.subarray(c + 6, c + 12)];
        while (constraints.length && constraints[constraints.length - 1] === 0)
            constraints.pop();
        return [`${entry.type}.${space}${general & 0x1f}`, compatibility, `${tier}${buffer[c + 12]}`, ...constraints.map(hex)].join('.');
    }
}

function descriptorLength(buffer: Buffer, position: number) {
    let length = 0;
    for (let i = 0; i < 4; i++) {
        const byte = buffer[position++];
        length = (length << 7) | (byte & 0x7f);
        if (!(byte & 0x80))
            break;
    }
    return { length, next: position };
}

function aacCodecs(buffer: Buffer, entry: Mp4Box) {
    const esds = mp4Boxes(buffer, entry.contentStart + 28, entry.end).find(box => box.type === 'esds');
    if (!esds)
        return;
    let position = esds.contentStart + 4;
    let objectType: number;
    while (position + 2 <= esds.end) {
        const tag = buffer[position];
        const { length, next } = descriptorLength(buffer, position + 1);
        if (tag === 3) {
            const flags = buffer[next + 2];
            position = next + 3 + (flags & 0x80 ? 2 : 0);
            position += flags & 0x40 ? 1 + buffer[position] : 0;
            position += flags & 0x20 ? 2 : 0;
        }
        else if (tag === 4) {
            objectType = buffer[next];
            position = next + 13;
        }
        else if (tag === 5) {
            if (objectType === undefined || !length)
                return;
            let audioObjectType = buffer[next] >> 3;
            if (audioObjectType === 31 && length > 1)
                audioObjectType = 32 + (((buffer[next] & 7) << 3) | (buffer[next + 1] >> 5));
            return `mp4a.${objectType.toString(16)}.${audioObjectType}`;
        }
        else {
            position = next + length;
        }
    }
}

export function mp4TrackInfo(init: Buffer): Mp4TrackInfo[] {
    const moov = mp4Boxes(init).find(box => box.type === 'moov');
    if (!moov)
        throw new Error('init segment without moov');
    const moovChildren = mp4Boxes(init, moov.contentStart, moov.end);
    const mvex = moovChildren.find(box => box.type === 'mvex');
    const trexes = mvex ? mp4Boxes(init, mvex.contentStart, mvex.end).filter(box => box.type === 'trex') : [];
    const tracks: Mp4TrackInfo[] = [];
    for (const trak of moovChildren.filter(box => box.type === 'trak')) {
        const mdia = child(init, trak, 'mdia');
        const hdlr = mdia && child(init, mdia, 'hdlr');
        const mdhd = mdia && child(init, mdia, 'mdhd');
        if (!hdlr || !mdhd)
            continue;
        const handler = init.toString('latin1', hdlr.contentStart + 8, hdlr.contentStart + 12);
        const kind = handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : undefined;
        if (!kind)
            continue;
        const id = tkhdTrackId(init, trak);
        const trex = trexes.find(box => init.readUInt32BE(box.contentStart + 4) === id);
        const minf = child(init, mdia, 'minf');
        const stbl = minf && child(init, minf, 'stbl');
        const stsd = stbl && child(init, stbl, 'stsd');
        const entry = stsd && mp4Boxes(init, stsd.contentStart + 8, stsd.end)[0];
        const track: Mp4TrackInfo = {
            id,
            kind,
            timescale: init.readUInt32BE(mdhd.contentStart + (init[mdhd.contentStart] === 1 ? 20 : 12)),
            defaultSampleDuration: trex ? init.readUInt32BE(trex.contentStart + 12) : 0,
        };
        try {
            if (entry && kind === 'video') {
                track.codecs = videoCodecs(init, entry);
                track.width = init.readUInt16BE(entry.contentStart + 24);
                track.height = init.readUInt16BE(entry.contentStart + 26);
            }
            else if (entry) {
                track.codecs = entry.type === 'Opus' ? 'Opus' : aacCodecs(init, entry);
            }
        }
        catch {
        }
        tracks.push(track);
    }
    return tracks;
}

function* trafs(segment: Buffer) {
    for (const moof of mp4Boxes(segment)) {
        if (moof.type !== 'moof')
            continue;
        for (const traf of mp4Boxes(segment, moof.contentStart, moof.end)) {
            if (traf.type !== 'traf')
                continue;
            const children = mp4Boxes(segment, traf.contentStart, traf.end);
            const tfhd = children.find(box => box.type === 'tfhd');
            if (!tfhd)
                continue;
            yield { children, tfhd, trackId: segment.readUInt32BE(tfhd.contentStart + 4) };
        }
    }
}

// Track ids that have samples in this media segment.
export function mp4SegmentTrackIds(segment: Buffer) {
    const ids = new Set<number>();
    for (const traf of trafs(segment))
        ids.add(traf.trackId);
    return ids;
}

// Duration in seconds of a track's samples in a media segment.
export function mp4SegmentDuration(segment: Buffer, track: Mp4TrackInfo) {
    let ticks = 0;
    for (const { children, tfhd, trackId } of trafs(segment)) {
        if (trackId !== track.id)
            continue;
        const tfhdFlags = segment.readUInt32BE(tfhd.contentStart) & 0xffffff;
        let offset = tfhd.contentStart + 8;
        if (tfhdFlags & 0x1)
            offset += 8;
        if (tfhdFlags & 0x2)
            offset += 4;
        const defaultDuration = tfhdFlags & 0x8 ? segment.readUInt32BE(offset) : track.defaultSampleDuration;
        for (const trun of children.filter(box => box.type === 'trun')) {
            const flags = segment.readUInt32BE(trun.contentStart) & 0xffffff;
            const count = segment.readUInt32BE(trun.contentStart + 4);
            let position = trun.contentStart + 8;
            if (flags & 0x1)
                position += 4;
            if (flags & 0x4)
                position += 4;
            const sampleSize = (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);
            for (let i = 0; i < count; i++) {
                ticks += flags & 0x100 ? segment.readUInt32BE(position) : defaultDuration;
                position += sampleSize;
            }
        }
    }
    return track.timescale ? ticks / track.timescale : 0;
}

// First tfdt per track id in a media segment.
export function mp4FirstTfdt(segment: Buffer) {
    const result: Record<number, bigint> = {};
    for (const { children, trackId } of trafs(segment)) {
        const tfdt = children.find(box => box.type === 'tfdt');
        if (!tfdt || trackId in result)
            continue;
        result[trackId] = segment[tfdt.contentStart] === 1
            ? segment.readBigUInt64BE(tfdt.contentStart + 4)
            : BigInt(segment.readUInt32BE(tfdt.contentStart + 4));
    }
    return result;
}

// Subtract a per-track base from every tfdt, so the clip timeline starts at zero.
export function mp4RebaseTfdt(segment: Buffer, base: Record<number, bigint>) {
    const out = Buffer.from(segment);
    for (const { children, trackId } of trafs(out)) {
        const tfdt = children.find(box => box.type === 'tfdt');
        if (!tfdt || base[trackId] === undefined)
            continue;
        if (out[tfdt.contentStart] === 1) {
            const value = out.readBigUInt64BE(tfdt.contentStart + 4) - base[trackId];
            out.writeBigUInt64BE(value < 0n ? 0n : value, tfdt.contentStart + 4);
        }
        else {
            const value = BigInt(out.readUInt32BE(tfdt.contentStart + 4)) - base[trackId];
            out.writeUInt32BE(Number(value < 0n ? 0n : value), tfdt.contentStart + 4);
        }
    }
    return out;
}

// Remove a track (trak and its trex) from an init segment.
export function mp4StripTrack(init: Buffer, id: number) {
    const parts: Buffer[] = [];
    for (const box of mp4Boxes(init)) {
        if (box.type !== 'moov') {
            parts.push(init.subarray(box.start, box.end));
            continue;
        }
        const children: Buffer[] = [];
        for (const moovChild of mp4Boxes(init, box.contentStart, box.end)) {
            if (moovChild.type === 'trak' && tkhdTrackId(init, moovChild) === id)
                continue;
            if (moovChild.type === 'mvex') {
                children.push(makeBox('mvex', ...mp4Boxes(init, moovChild.contentStart, moovChild.end)
                    .filter(x => !(x.type === 'trex' && init.readUInt32BE(x.contentStart + 4) === id))
                    .map(x => init.subarray(x.start, x.end))));
                continue;
            }
            children.push(init.subarray(moovChild.start, moovChild.end));
        }
        parts.push(makeBox('moov', ...children));
    }
    return Buffer.concat(parts);
}
