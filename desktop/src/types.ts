import type { DownloadBridge } from './downloads';
import type { LyricWord } from './lib/music';

export interface Track {
  key: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  language?: string;
  genre?: string;
  releaseDate?: string;
  recordLabel?: string;
  introduction?: string;
  coverUrl?: string;
  mid?: string;
  songId?: number;
  localId?: string;
  source: "local" | "online";
}

export type PlayMode = "list" | "single" | "shuffle";
export type Quality = "128" | "320" | "flac";

export type DesktopPlaybackCommand = "toggle" | "previous" | "next";

export interface FolderImportResult {
  tracks: Track[];
  canceled?: boolean;
  truncated: boolean;
  scannedEntries: number;
  skippedDirectories: number;
}
export interface TrayPlayerState {
  title: string;
  artist: string;
  playing: boolean;
  favorite: boolean;
  volume: number;
  muted: boolean;
  hasTrack: boolean;
  hasQueue: boolean;
}
export type TrayPlayerCommand = {action: 'favorite' | 'queue' | 'mute' | 'volume'; value?: number};

export type ClosePromptAction = 'hide' | 'quit' | 'cancel';
export interface DesktopPreferences {
  closeAction: 'ask' | 'hide' | 'quit';
  shortcutsEnabled: boolean;
}
export interface ClosePromptState {
  id: number;
  canHide: boolean;
}

export interface DesktopLyricsContent {
  title: string;
  artist: string;
  line: string;
  nextLine: string;
  playing: boolean;
  accentColor: string;
  fontSize: number;
  fontFamily: string;
  opacity: number;
  singleLine: boolean;
  borderRadius: number;
  backgroundImage: string | null;
  words: LyricWord[];
  lineStart: number;
  lineEnd: number;
  position: number;
  playbackRate: number;
  loading: boolean;
}

export interface DesktopLyricsState {
  visible: boolean;
  locked: boolean;
}

export interface ApiRequest {
  baseUrl?: string;
  path: "/api/search" | "/api/song/url" | "/api/song/detail" | "/api/lyric" | "/api/top" | "/api/playlist"
    | "/splcloud/fcgi-bin/fcg_get_diss_tag_conf.fcg" | "/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg";
  params: Record<string, string | number | boolean>;
}

export interface DesktopBridge extends DownloadBridge {
  importAudio(): Promise<Track[]>;
  importAudioFolders(): Promise<FolderImportResult>;
  resolvePlaylistId(input: string): Promise<string | undefined>;
  updateTrayPlayer(state: TrayPlayerState): void;
  onTrayPlayerCommand(listener: (command: TrayPlayerCommand) => void): () => void;
  getLocalTracks(): Promise<Track[]>;
  onLocalTracksChanged(listener: (tracks: Track[]) => void): () => void;
  resolveDownloadedAudio(input: {mid: string; quality: Quality}): Promise<string | undefined>;
  removeLocalTrack(localId: string): Promise<void>;
  resolveLocalAudio(localId: string): Promise<string>;
  readLocalLyrics(localId: string): Promise<string>;
  requestApi(request: ApiRequest): Promise<unknown>;
  getVersion(): Promise<string>;
  getDesktopLyricsState(): Promise<DesktopLyricsState>;
  setDesktopLyricsVisible(visible: boolean): Promise<DesktopLyricsState>;
  setDesktopLyricsLocked(locked: boolean): Promise<DesktopLyricsState>;
  updateDesktopLyrics(content: Partial<DesktopLyricsContent>): void;
  onDesktopLyricsState(listener: (state: DesktopLyricsState) => void): () => void;
  onDesktopPlaybackCommand(listener: (command: DesktopPlaybackCommand) => void): () => void;
  getClosePrompt(): Promise<ClosePromptState | null>;
  onClosePrompt(listener: (state: ClosePromptState | null) => void): () => void;
  respondToClosePrompt(response: {id: number; action: ClosePromptAction; remember?: boolean}): Promise<ClosePromptState | null>;
  getPreferences(): Promise<DesktopPreferences>;
  setPreferences(patch: Partial<DesktopPreferences>): Promise<DesktopPreferences>;
  onPreferencesChanged(listener: (preferences: DesktopPreferences) => void): () => void;
  copyText(text: string): Promise<void>;
  openProjectPage(): Promise<void>;
  resolveOnlineAudio(input: {mid: string; quality: Quality; baseUrl?: string}): Promise<string | {code: 'AUDIO_URL_EXPIRED'; message: string}>;
  getOnlineAudioFailure(source: string): Promise<{code: 'AUDIO_URL_EXPIRED' | 'AUDIO_TOKEN_EXPIRED'; message: string} | undefined>;
  minimize(): void;
  maximize(): void;
  close(): void;
}

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}
