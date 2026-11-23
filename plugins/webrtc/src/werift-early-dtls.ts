import type { RTCPeerConnection } from "./werift";

// werift creates its DTLS server only after ICE completes. A peer that starts
// the DTLS handshake as soon as its ICE check succeeds (Apple's HomeKit relay
// does) has its first ClientHello dropped, and the session stalls until the peer
// gives up. Buffer DTLS records that arrive while the transport is still "new"
// and replay them into the DTLS socket once it exists.
//
// After the handshake, ignore a retransmitted epoch-0 ClientHello: feeding it to
// the established DTLS server restarts the handshake and breaks the session.
export function replayEarlyDtlsRecords(pc: RTCPeerConnection, console: Console) {
    const isDtlsRecord = (b: Buffer) => b?.length > 0 && b[0] > 19 && b[0] < 64;
    const isClientHello = (b: Buffer) => b?.length > 13 && b[0] === 22 && b.readUInt16BE(3) === 0 && b[13] === 1;

    for (const dtls of (pc as any).dtlsTransports || []) {
        const early: Buffer[] = [];
        const data = dtls.iceTransport?.connection?.onData?.subscribe((b: Buffer) => {
            if (dtls.state === 'new' && isDtlsRecord(b) && early.length < 8)
                early.push(b);
        });
        if (!data)
            continue;
        const state = dtls.onStateChange.subscribe((s: string) => {
            if (s === 'new')
                return;
            data.unSubscribe();
            state.unSubscribe();
            if (s !== 'connecting') {
                if (early.length)
                    console.log('early DTLS records dropped, state', s, early.length);
                return;
            }
            setImmediate(() => {
                const socket = dtls.dtls?.transport?.socket;
                if (!socket)
                    return;
                const onData = socket.onData;
                socket.onData = (b: Buffer) => {
                    if (dtls.state === 'connected' && isClientHello(b))
                        return;
                    return onData.call(socket, b);
                };
                for (const b of early)
                    socket.onData(b);
                if (early.length)
                    console.log('early DTLS records replayed:', early.length);
            });
        });
    }
}
