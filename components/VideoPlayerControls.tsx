"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Hls from "hls.js";

interface VideoPlayerControlsProps {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    hls?: Hls | null;
    title?: string;
    isLive?: boolean;
    onPlayRequest?: () => void;
    onPauseRequest?: () => void;
}

function inferHeightFromBitrate(bitrate: number) {
    if (!Number.isFinite(bitrate) || bitrate <= 0) return 0;
    if (bitrate >= 7000000) return 2160;
    if (bitrate >= 4000000) return 1080;
    if (bitrate >= 2200000) return 720;
    if (bitrate >= 1100000) return 480;
    if (bitrate >= 650000) return 360;
    return 240;
}

function getFallbackQualityHeight(index: number, totalLevels: number) {
    const ladders = [
        [480],
        [720, 480],
        [1080, 720, 480],
        [1080, 720, 480, 360],
        [1080, 720, 480, 360, 240],
    ];
    const ladder = ladders[Math.max(0, Math.min(ladders.length - 1, totalLevels - 1))] || [480];
    return ladder[Math.max(0, Math.min(index, ladder.length - 1))] || 480;
}

function getLevelLabel(
    level: { height?: number; width?: number; bitrate?: number; name?: string },
    index: number,
    totalLevels: number
) {
    const explicitHeight = Number(level?.height || 0);
    if (explicitHeight > 0) return `${explicitHeight}p`;

    const name = String(level?.name || "").trim();
    const nameMatch = name.match(/(\d{3,4})p/i);
    if (nameMatch?.[1]) return `${nameMatch[1]}p`;

    const bitrateHeight = inferHeightFromBitrate(Number(level?.bitrate || 0));
    if (bitrateHeight > 0) return `${bitrateHeight}p`;

    const width = Number(level?.width || 0);
    if (width >= 360) {
        const estimatedHeight = Math.round((width * 9) / 16);
        if (estimatedHeight >= 200) return `${estimatedHeight}p`;
    }

    return `${getFallbackQualityHeight(index, totalLevels)}p`;
}

export default function VideoPlayerControls({
    videoRef,
    hls,
    title,
    isLive = true,
    onPlayRequest,
    onPauseRequest,
}: VideoPlayerControlsProps) {
    const [isPlaying, setIsPlaying] = useState(false);
    const [volume, setVolume] = useState(1);
    const [isMuted, setIsMuted] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [showControls, setShowControls] = useState(true);
    const [progress, setProgress] = useState(0);
    const [duration, setDuration] = useState(0);

    const controlsTimeoutRef = useRef<number | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const clearControlsTimeout = useCallback(() => {
        if (controlsTimeoutRef.current) {
            window.clearTimeout(controlsTimeoutRef.current);
            controlsTimeoutRef.current = null;
        }
    }, []);

    const resetControlsTimeout = useCallback(() => {
        setShowControls(true);
        clearControlsTimeout();
        const video = videoRef.current;
        if (!video || video.paused) return;
        controlsTimeoutRef.current = window.setTimeout(() => {
            setShowControls(false);
        }, isFullscreen ? 1600 : 2200);
    }, [clearControlsTimeout, isFullscreen, videoRef]);

    useEffect(() => {
        const target = containerRef.current?.parentElement || videoRef.current;
        if (!target) return;

        const revealControls = () => resetControlsTimeout();
        target.addEventListener("mousemove", revealControls);
        target.addEventListener("touchstart", revealControls, { passive: true });
        target.addEventListener("pointerdown", revealControls);

        return () => {
            target.removeEventListener("mousemove", revealControls);
            target.removeEventListener("touchstart", revealControls);
            target.removeEventListener("pointerdown", revealControls);
        };
    }, [resetControlsTimeout, videoRef]);

    useEffect(() => {
        if (isPlaying) {
            resetControlsTimeout();
            return;
        }
        setShowControls(true);
        clearControlsTimeout();
    }, [clearControlsTimeout, isPlaying, resetControlsTimeout]);

    useEffect(() => {
        return () => {
            clearControlsTimeout();
        };
    }, []);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const onPlay = () => {
            setIsPlaying(true);
            resetControlsTimeout();
        };
        const onPause = () => {
            setIsPlaying(false);
            setShowControls(true);
            clearControlsTimeout();
        };
        const onVolumeChange = () => {
            setVolume(video.volume);
            setIsMuted(video.muted);
        };
        const onTimeUpdate = () => {
            setProgress(video.currentTime);
        };
        const onDurationChange = () => {
            setDuration(video.duration);
        };
        const onError = () => {
            setShowControls(true);
            clearControlsTimeout();
        };

        video.addEventListener("play", onPlay);
        video.addEventListener("pause", onPause);
        video.addEventListener("volumechange", onVolumeChange);
        video.addEventListener("timeupdate", onTimeUpdate);
        video.addEventListener("durationchange", onDurationChange);
        video.addEventListener("error", onError);

        // Initial state
        setIsPlaying(!video.paused);
        setVolume(video.volume);
        setIsMuted(video.muted);

        return () => {
            video.removeEventListener("play", onPlay);
            video.removeEventListener("pause", onPause);
            video.removeEventListener("volumechange", onVolumeChange);
            video.removeEventListener("timeupdate", onTimeUpdate);
            video.removeEventListener("durationchange", onDurationChange);
            video.removeEventListener("error", onError);
        };
    }, [clearControlsTimeout, videoRef, resetControlsTimeout]);

    // Handle Fullscreen changes
    useEffect(() => {
        const onFsChange = () => {
            setIsFullscreen(!!document.fullscreenElement);
            setShowControls(true);
            resetControlsTimeout();
        };
        document.addEventListener("fullscreenchange", onFsChange);
        return () => document.removeEventListener("fullscreenchange", onFsChange);
    }, []);

    const togglePlay = useCallback((e?: React.MouseEvent) => {
        e?.stopPropagation();
        const video = videoRef.current;
        if (!video) return;
        if (video.paused) {
            if (onPlayRequest) {
                onPlayRequest();
                resetControlsTimeout();
                return;
            }
            video.play().catch(() => { });
        } else {
            if (onPauseRequest) {
                onPauseRequest();
                resetControlsTimeout();
                return;
            }
            video.pause();
        }
        resetControlsTimeout();
    }, [onPauseRequest, onPlayRequest, videoRef, resetControlsTimeout]);

    const toggleMute = useCallback((e?: React.MouseEvent) => {
        e?.stopPropagation();
        const video = videoRef.current;
        if (!video) return;
        video.muted = !video.muted;
        resetControlsTimeout();
    }, [videoRef, resetControlsTimeout]);

    const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const video = videoRef.current;
        if (!video) return;
        const val = Number(e.target.value);
        video.volume = val;
        if (val > 0) video.muted = false;
        resetControlsTimeout();
    }, [videoRef, resetControlsTimeout]);

    const toggleFullscreen = useCallback((e?: React.MouseEvent) => {
        e?.stopPropagation();
        const video = videoRef.current;
        // We try to find the container or use video
        const target = containerRef.current?.parentElement || video;
        if (!target) return;

        if (!document.fullscreenElement) {
            target.requestFullscreen?.().catch(() => { });
        } else {
            document.exitFullscreen?.().catch(() => { });
        }
        resetControlsTimeout();
    }, [videoRef, resetControlsTimeout]);

    const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const video = videoRef.current;
        if (!video) return;
        const time = Number(e.target.value);
        video.currentTime = time;
        resetControlsTimeout();
    }, [videoRef, resetControlsTimeout]);

    const formatTime = (s: number) => {
        if (!Number.isFinite(s)) return "0:00";
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m}:${sec < 10 ? "0" : ""}${sec}`;
    };
    const isAudioOff = isMuted || volume === 0;

    return (
        <div
            ref={containerRef}
            className={`pointer-events-none absolute inset-0 z-50 flex flex-col justify-between transition-opacity duration-300 ${
                showControls || !isPlaying ? "opacity-100" : "opacity-0"
            }`}
            onMouseMove={resetControlsTimeout}
            style={{ background: showControls ? "linear-gradient(to top, rgba(0,0,0,0.8), transparent 30%)" : "transparent" }}
        >
            {/* Top Bar */}
            <div
                className="flex justify-between items-start gap-3 bg-gradient-to-b from-black/60 to-transparent"
                style={{
                    paddingLeft: "max(1rem, env(safe-area-inset-left))",
                    paddingRight: "max(1rem, env(safe-area-inset-right))",
                    paddingTop: "max(0.75rem, env(safe-area-inset-top))",
                    paddingBottom: "0.75rem",
                }}
            >
                <div className="text-white font-bold drop-shadow-md">
                    {title || (isLive ? "Live Stream" : "Video")}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {isLive && (
                        <div className="flex items-center gap-2 bg-red-600/80 px-2 py-1 rounded text-xs font-bold text-white shadow-sm backdrop-blur-sm">
                            <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                            LIVE
                        </div>
                    )}
                </div>
            </div>

            {/* Center Play Button (only if paused/buffering) */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                {!isPlaying && (
                    <div className="w-16 h-16 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center border border-white/30 shadow-xl transition-transform transform scale-100">
                        <PlayIcon size={32} fill="white" />
                    </div>
                )}
            </div>

            {/* Bottom Controls */}
            <div
                className={`bg-black/40 backdrop-blur-md border-t border-white/10 ${
                    showControls || !isPlaying ? "pointer-events-auto" : "pointer-events-none"
                }`}
                style={{
                    paddingLeft: "max(1rem, env(safe-area-inset-left))",
                    paddingRight: "max(1rem, env(safe-area-inset-right))",
                    paddingTop: "0.75rem",
                    paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))",
                }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()} // Prevent playing when clicking bar
            >
                {/* Progress Bar (if not live or valid duration) */}
                {!isLive && duration > 0 && (
                    <div className="flex items-center gap-3 text-xs font-mono text-gray-300 mb-2">
                        <span>{formatTime(progress)}</span>
                        <input
                            type="range"
                            min={0}
                            max={duration}
                            step={0.1}
                            value={progress}
                            onChange={handleSeek}
                            className="flex-1 accent-blue-500 h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer"
                        />
                        <span>{formatTime(duration)}</span>
                    </div>
                )}

                <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                        <button
                            onClick={togglePlay}
                            className="shrink-0 text-white hover:text-blue-400 transition-colors focus:outline-none"
                        >
                            {isPlaying ? <PauseIcon /> : <PlayIcon />}
                        </button>

                        <div className="flex items-center gap-2">
                            <button
                                onClick={toggleMute}
                                className={[
                                    "rounded-md border px-1.5 py-1 transition-colors",
                                    isAudioOff
                                        ? "text-red-300 border-red-500/60 bg-red-500/20 hover:text-red-200"
                                        : "text-emerald-300 border-emerald-500/60 bg-emerald-500/20 hover:text-emerald-200",
                                ].join(" ")}
                                aria-label={isAudioOff ? "Unmute" : "Mute"}
                            >
                                <VolumeIcon muted={isAudioOff} />
                            </button>
                            <input
                                type="range"
                                min={0}
                                max={1}
                                step={0.05}
                                value={isAudioOff ? 0 : volume}
                                onChange={handleVolumeChange}
                                className={[
                                    "w-20 sm:w-24 h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer",
                                    isAudioOff ? "accent-red-500" : "accent-emerald-500",
                                ].join(" ")}
                            />
                        </div>
                    </div>

                    <div className="flex items-center gap-4 shrink-0">
                        {/* Quality Selector (if HLS levels exist) */}
                        {hls && hls.levels && hls.levels.length > 0 && (
                            <QualitySelector hls={hls} />
                        )}
                        <button onClick={toggleFullscreen} className="text-white hover:text-blue-400 transition-colors" aria-label="Fullscreen">
                            <FullscreenIcon isFs={isFullscreen} />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

// Icons
function PlayIcon({ size = 24, fill = "currentColor" }: { size?: number, fill?: string }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth="0" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
        </svg>
    );
}

function PauseIcon({ size = 24 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none">
            <rect x="6" y="4" width="4" height="16"></rect>
            <rect x="14" y="4" width="4" height="16"></rect>
        </svg>
    );
}

function VolumeIcon({ size = 24, muted = false }: { size?: number; muted?: boolean }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
            {muted ? (
                <>
                    <line x1="22" y1="8" x2="16" y2="14"></line>
                    <line x1="16" y1="8" x2="22" y2="14"></line>
                </>
            ) : null}
        </svg>
    );
}

function FullscreenIcon({ size = 24, isFs = false }: { size?: number, isFs?: boolean }) {
    if (isFs) {
        return (
            <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"></path>
            </svg>
        )
    }
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path>
        </svg>
    );
}

function QualitySelector({ hls }: { hls: Hls }) {
    const [manualLevel, setManualLevel] = useState(hls.manualLevel);
    const [currentLevel, setCurrentLevel] = useState(hls.currentLevel);
    const [showMenu, setShowMenu] = useState(false);

    useEffect(() => {
        const syncState = () => {
            setManualLevel(hls.manualLevel);
            setCurrentLevel(hls.currentLevel);
        };
        syncState();
        const onLevelSwitched = (_event: string, data: { level: number }) => {
            setCurrentLevel(data.level);
            setManualLevel(hls.manualLevel);
        };
        const onManifestParsed = () => syncState();
        const onLevelsUpdated = () => syncState();
        hls.on(Hls.Events.LEVEL_SWITCHED, onLevelSwitched);
        hls.on(Hls.Events.MANIFEST_PARSED, onManifestParsed);
        hls.on(Hls.Events.LEVELS_UPDATED, onLevelsUpdated);
        return () => {
            hls.off(Hls.Events.LEVEL_SWITCHED, onLevelSwitched);
            hls.off(Hls.Events.MANIFEST_PARSED, onManifestParsed);
            hls.off(Hls.Events.LEVELS_UPDATED, onLevelsUpdated);
        };
    }, [hls]);

    const levels = hls.levels || [];
    if (levels.length < 1) return null;

    const autoEnabled = hls.autoLevelEnabled || manualLevel === -1;
    const currentAutoLabel =
        currentLevel >= 0 && levels[currentLevel] ? getLevelLabel(levels[currentLevel], currentLevel, levels.length) : "";
    const selectedLabel =
        manualLevel >= 0 && levels[manualLevel] ? getLevelLabel(levels[manualLevel], manualLevel, levels.length) : "";

    const applyLevel = (nextLevel: number, e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        if (nextLevel < 0) {
            hls.currentLevel = -1;
            hls.nextLevel = -1;
            hls.loadLevel = -1;
            hls.autoLevelCapping = -1;
            setManualLevel(-1);
        } else {
            hls.currentLevel = nextLevel;
            hls.nextLevel = nextLevel;
            hls.loadLevel = nextLevel;
            setManualLevel(nextLevel);
        }
        setCurrentLevel(nextLevel);
        setShowMenu(false);
    };

    const levelEntries = levels
        .map((lvl, idx) => ({
            idx,
            label: getLevelLabel(lvl, idx, levels.length),
            sortHeight: Number.parseInt(getLevelLabel(lvl, idx, levels.length), 10) || 0,
            bitrate: Number(lvl?.bitrate || 0),
        }))
        .sort((a, b) => {
            if (b.sortHeight !== a.sortHeight) return b.sortHeight - a.sortHeight;
            if (b.bitrate !== a.bitrate) return b.bitrate - a.bitrate;
            return a.idx - b.idx;
        });

    return (
        <div className="relative">
            <button
                onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
                className="text-[11px] sm:text-xs font-bold text-gray-300 hover:text-white border border-gray-600 rounded px-2 py-1 whitespace-nowrap"
            >
                {autoEnabled ? (currentAutoLabel ? `Auto (${currentAutoLabel})` : "Auto") : selectedLabel || "جودة"}
            </button>
            {showMenu && (
                <div className="absolute bottom-full mb-2 left-0 bg-black/90 border border-gray-700 rounded-lg p-2 flex flex-col gap-1 min-w-[80px]">
                    <button
                        onClick={(e) => applyLevel(-1, e)}
                        className={`text-left text-xs px-2 py-1 rounded ${autoEnabled ? "bg-blue-600 text-white" : "text-gray-300 hover:bg-white/10"}`}
                    >
                        {currentAutoLabel ? `Auto (${currentAutoLabel})` : "Auto"}
                    </button>
                    {levelEntries.map((entry) => (
                        <button
                            key={entry.idx}
                            onClick={(e) => applyLevel(entry.idx, e)}
                            className={`text-left text-xs px-2 py-1 rounded ${!autoEnabled && manualLevel === entry.idx ? "bg-blue-600 text-white" : "text-gray-300 hover:bg-white/10"}`}
                        >
                            {entry.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}
