import { Accessory, AudioBitrate, AudioRecordingCodecType, AudioRecordingSamplerate, CameraRecordingDelegate, CameraStreamingDelegate, CameraVideoQuality, Characteristic, H264Level, H264Profile, MediaContainerType, SecureVideoController, SecureVideoVideoTier, Service, StreamTierAudioBitDepth, StreamTierAudioSampleRate, StreamTierVideoCodec, uuid, VideoCodecType } from '../../hap';
import type { createMultiTierRtpDelegate } from './camera-multitier-rtp';
import type { createHomeKitWebRTCDelegate } from './camera-webrtc';
import type { CMAFSegment } from '../../hap';
import type { SecureVideoUserAgent } from '../../hap';

export interface SecureVideoUploadOptions {
    userAgent: () => SecureVideoUserAgent;
    /** the lowest CMAF session number to use next, see the controller's ingest options */
    minimumSessionNumber?: () => bigint;
    /** false uploads clips in the clear */
    encrypt?: () => boolean;
}

// CMAF direct upload: current hubs refuse to enable "Stream & Record" for an
// HKSV3 camera that does not expose the CMAF services
// ("Camera HAP service not found: Camera Client Certificate Management").
export const secureVideoCmafEnabled = true;

// Used until the hub writes a recording configuration.
const FALLBACK_RECORDING_CONFIGURATION: any = {
    prebufferLength: 8000,
    eventTriggerTypes: [1],
    mediaContainerConfiguration: { type: MediaContainerType.FRAGMENTED_MP4, fragmentLength: 4000 },
    videoCodec: { type: VideoCodecType.H264, parameters: { profile: 1, level: 2, bitRate: 2000, iFrameInterval: 4000 }, resolution: [1920, 1080, 30] },
    audioCodec: { type: AudioRecordingCodecType.AAC_LC, audioChannels: 1, samplerate: AudioRecordingSamplerate.KHZ_32, bitrate: 64 },
};

export function createSecureVideoController(accessory: Accessory,
    snapshot: CameraStreamingDelegate['handleSnapshotRequest'], console: Console,
    recordingDelegate: CameraRecordingDelegate,
    createRtpDelegate: (tiers: SecureVideoVideoTier[]) => ReturnType<typeof createMultiTierRtpDelegate>,
    createWebRTCDelegate?: (tiers: SecureVideoVideoTier[]) => ReturnType<typeof createHomeKitWebRTCDelegate>,
    resolution?: number[],
    upload?: SecureVideoUploadOptions) {
    const encoding = (width: number, height: number, targetAverageBitrate: number, peakBitrate: number) =>
        ({ width, height, frameRate: 30, targetAverageBitrate, peakBitrate });
    const families = [
        {
            ratio: 16 / 9,
            high: [encoding(3840, 2160, 4500, 5000), encoding(2560, 1440, 2800, 3000), encoding(1920, 1080, 1700, 1800)],
            medium: [encoding(1920, 1080, 1700, 1800), encoding(1280, 720, 768, 800)],
            low: [encoding(640, 360, 180, 190)],
        },
        {
            ratio: 4 / 3,
            high: [encoding(1600, 1200, 2800, 3000)],
            medium: [encoding(1440, 1080, 1700, 1800)],
            low: [encoding(640, 480, 180, 190), encoding(320, 240, 180, 190)],
        },
        {
            ratio: 9 / 16,
            high: [encoding(1080, 1920, 1700, 1800)],
            medium: [encoding(720, 1280, 768, 800)],
            low: [encoding(360, 640, 180, 190)],
        },
        {
            ratio: 3 / 4,
            high: [encoding(2400, 3200, 4500, 5000), encoding(1536, 2048, 2800, 3000), encoding(1200, 1600, 1700, 1800)],
            medium: [encoding(1200, 1600, 1700, 1800), encoding(960, 1280, 768, 800)],
            low: [encoding(480, 640, 180, 190)],
        },
        {
            ratio: 1,
            high: [encoding(1440, 1440, 2800, 3000)],
            medium: [encoding(1080, 1080, 1700, 1800)],
            low: [encoding(480, 480, 180, 190)],
        },
    ];

    const [width, height] = resolution?.length >= 2 && resolution.slice(0, 2).every(value => Number.isFinite(value) && value > 0)
        ? resolution : [3840, 2160];
    const aspectRatio = width / height;
    const family = families.reduce((best, family) =>
        Math.abs(family.ratio - aspectRatio) < Math.abs(best.ratio - aspectRatio) ? family : best);
    const bestFit = (candidates: ReturnType<typeof encoding>[]) => {
        const fitting = candidates.filter(tier => tier.width <= width && tier.height <= height);
        return fitting.length
            ? fitting.reduce((best, tier) => tier.width * tier.height > best.width * best.height ? tier : best)
            : candidates.reduce((best, tier) => tier.width * tier.height < best.width * best.height ? tier : best);
    };
    const high = bestFit(family.high);
    const medium = bestFit(family.medium.filter(tier => tier.width < high.width && tier.height < high.height));
    const tiers: SecureVideoVideoTier[] = [
        { ...high, identifier: 1, quality: CameraVideoQuality.HIGH },
        { ...medium, identifier: 2, quality: CameraVideoQuality.MEDIUM },
        { ...bestFit(family.low), identifier: 3, quality: CameraVideoQuality.LOW },
    ];

    const notImplemented = (operation: string): never => {
        const message = `HomeKit Secure Video 3 ${operation} is not implemented yet.`;
        console.log(message);
        throw new Error(message);
    };

    let recordingConfigured = false;
    // pre-motion: the hub's selected prebuffer length is kept before the start of each upload
    let preRoll = FALLBACK_RECORDING_CONFIGURATION.prebufferLength;
    let nextClipStreamId = 880000;
    const updateRecordingConfiguration = recordingDelegate.updateRecordingConfiguration.bind(recordingDelegate);
    recordingDelegate.updateRecordingConfiguration = configuration => {
        recordingConfigured = !!configuration;
        if (configuration?.prebufferLength)
            preRoll = configuration.prebufferLength;
        return updateRecordingConfiguration(configuration);
    };

    const motionService = accessory.addService(Service.MotionSensor, 'Motion Sensor');
    motionService.setCharacteristic(Characteristic.MotionDetected, false);

    const rtpDelegate = createRtpDelegate(tiers);
    const webrtcDelegate = createWebRTCDelegate?.(tiers);
    const controller = new SecureVideoController({
        sensor: {
            uuid: uuid.generate(`${accessory.UUID}:sensor`),
            width,
            height,
        },
        video: {
            codec: StreamTierVideoCodec.H265,
            payloadType: 99,
            tiers,
        },
        audio: {
            payloadType: 110,
            twoWayAudio: true,
            tier: {
                identifier: 1,
                targetAverageBitrate: 24000,
                sampleRate: StreamTierAudioSampleRate.KHZ_48,
                bitDepth: StreamTierAudioBitDepth.BITS_16,
                packetTime: 20,
                channels: 1,
            },
        },
        rtp: {
            delegate: rtpDelegate,
        },
        webrtc: {
            maxSessions: 16,
            delegate: webrtcDelegate || {
                async handleSolicitOffer() {
                    return notImplemented('WebRTC streaming');
                },
                async handleProvideAnswer() {
                    return notImplemented('WebRTC streaming');
                },
                async handleReoffer() {
                    return notImplemented('WebRTC renegotiation');
                },
                async handleUpdateSession() {
                    return notImplemented('SFrame key updates');
                },
                async handleEndSession() { },
            },
        },
        // Retain the legacy recording advertisement while the HSV3 HDS media
        // pipeline requests native HEVC/AAC. CMAF direct upload is separate.
        recording: {
            options: {
                prebufferLength: 8000,
                mediaContainerConfiguration: [{ type: MediaContainerType.FRAGMENTED_MP4, fragmentLength: 4000 }],
                video: {
                    type: VideoCodecType.H264,
                    parameters: {
                        levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
                        profiles: [H264Profile.MAIN],
                    },
                    resolutions: [[1280, 720, 30], [1920, 1080, 30]],
                },
                audio: {
                    codecs: [{
                        type: AudioRecordingCodecType.AAC_LC,
                        bitrateMode: AudioBitrate.VARIABLE,
                        samplerate: AudioRecordingSamplerate.KHZ_32,
                        audioChannels: 1,
                    }],
                },
            },
            delegate: recordingDelegate,
        },
        ingest: secureVideoCmafEnabled && upload ? {
            userAgent: upload.userAgent,
            muxed: true,
            encrypt: upload.encrypt,
            preRoll: () => preRoll,
            minimumSessionNumber: upload.minimumSessionNumber,
            log: message => console.log('HKSV3', message),
            delegate: {
                // Clip production reuses the classic HKSV fragmented MP4 recording
                // generator: the first fragment (ftyp+moov) is the init segment,
                // the rest (moof+mdat) are media segments.
                async *streamClip(request): AsyncGenerator<CMAFSegment> {
                    if (!recordingConfigured) {
                        console.log('HKSV3 clip: no recording configuration from the hub yet, using fallback');
                        updateRecordingConfiguration(FALLBACK_RECORDING_CONFIGURATION);
                    }
                    const streamId = nextClipStreamId++;
                    const generator = recordingDelegate.handleRecordingStreamRequest(streamId);
                    let count = 0;
                    try {
                        for await (const packet of generator) {
                            const last = !!packet.isLast || request.signal.aborted;
                            if (count++ === 0) {
                                yield { type: 'init', data: packet.data };
                                continue;
                            }
                            yield { type: 'media', data: packet.data, last };
                            if (last)
                                break;
                        }
                    }
                    finally {
                        try {
                            recordingDelegate.closeRecordingStream(streamId, 0);
                        }
                        catch {
                        }
                        await generator.return(undefined).catch(() => { });
                    }
                },
                handleBufferActivity() {
                },
                updateRecordingActive(active, audioActive) {
                    console.log('HKSV3 recording active:', { active, audioActive });
                },
                updatePublishingPoint(publishingPoint) {
                    console.log('HKSV3 publishing point configured:', !!publishingPoint);
                },
                updateClientCertificate(installed) {
                    console.log('HKSV3 client certificate installed:', installed);
                },
                handleUploadResult(cmafSessionId, error, detail) {
                    if (error)
                        console.log('HKSV3 upload result:', { cmafSessionId: cmafSessionId.toString(), error, detail });
                },
            },
        } : undefined,
        motionService,
        snapshot(request) {
            return new Promise((resolve, reject) => {
                snapshot(request || { width: tiers[0].width, height: tiers[0].height }, (error, image) => {
                    if (error) {
                        reject(error);
                    }
                    else {
                        resolve(image);
                    }
                });
            });
        },
    });
    if (webrtcDelegate)
        webrtcDelegate.onSessionEnded = id => controller.endWebRTCSession(id);
    // Stop live media immediately when the controller's privacy/streaming gates close.
    const configureServices = controller.configureServices.bind(controller);
    controller.configureServices = () => {
        configureServices();
        controller.multiTierStreamManagementService.getCharacteristic(Characteristic.StatusActive)
            .on('change', change => { if (!change.newValue) rtpDelegate.stopAll(); });
        const checkWebRTCStreaming = () => {
            if (!controller.streamingAllowed(controller.webrtcStreamManagementService)) {
                for (const id of controller.activeWebRTCSessions)
                    controller.endWebRTCSession(id).catch(() => console.log('HSV3 WebRTC cleanup failed'));
            }
        };
        controller.webrtcStreamManagementService.getCharacteristic(Characteristic.StreamingEnabled)
            .on('change', checkWebRTCStreaming);
        for (const characteristic of [Characteristic.HomeKitCameraActive, Characteristic.StreamingEnabled, Characteristic.ManuallyDisabled]) {
            if (controller.globalOperatingModeService?.testCharacteristic(characteristic))
                controller.globalOperatingModeService.getCharacteristic(characteristic).on('change', checkWebRTCStreaming);
        }
    };
    const remove = controller.handleControllerRemoved.bind(controller);
    controller.handleControllerRemoved = () => {
        rtpDelegate.stopAll();
        webrtcDelegate?.stopAll();
        remove();
    };
    return controller;
}
