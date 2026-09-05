# Bundled FFmpeg decoder

The native archives under `ffmpeg/android-libs` were built from FFmpeg 4.2 using
the ExoPlayer 2.19.0 FFmpeg extension JNI bridge. Enabled audio decoders are
AAC, ALAC, FLAC, MP3, Opus and Vorbis.

The Java renderer is the matching ExoPlayer 2.19.0 source implementation. The
KotlinAudio player creates `DefaultRenderersFactory` in extension-preferred mode
with decoder fallback enabled, so FFmpeg receives supported compressed audio
before the platform decoder.

FFmpeg is LGPL-licensed. See `ffmpeg/LICENSE.md` and `ffmpeg/COPYING.LGPLv2.1`.
