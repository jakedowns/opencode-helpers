/**
 * Single definition of the voice commands shared by the GUI and TUI parts.
 *
 * Both clients build their palette entries from VOICE_PALETTE and parse the
 * same `/voice` arguments, so a command cannot exist in one client and not the
 * other by accident. `clients` marks the genuinely client-specific ones
 * (the sidebar toggle only exists in the TUI).
 */
export type VoiceClient = "gui" | "tui"

export interface VoicePaletteCommand {
  id: string
  title: string
  keywords: string
  /** Input handed to the shared dispatcher when the palette entry runs. */
  input: string
  clients: VoiceClient[]
}

export const VOICE_SLASH = {
  name: "voice",
  aliases: ["audio"],
  usage: "/voice [open|status|mute|unmute|toggle|repeat|summary|purge|sidebar] [session|project|global|days]",
} as const

export const VOICE_PALETTE: VoicePaletteCommand[] = [
  {
    id: "open",
    title: "Voice: open audio tool",
    keywords: "audio speech tts panel show",
    input: "open",
    clients: ["gui", "tui"],
  },
  {
    id: "status",
    title: "Voice: show auto-speak status",
    keywords: "mute muted state",
    input: "status",
    clients: ["gui", "tui"],
  },
  {
    id: "repeat",
    title: "Voice: speak previous reply",
    keywords: "again replay last read aloud",
    input: "repeat",
    clients: ["gui", "tui"],
  },
  {
    id: "summary",
    title: "Voice: summarize where we're at",
    keywords: "status recap progress spoken",
    input: "summary",
    clients: ["gui", "tui"],
  },
  {
    id: "mute-session",
    title: "Voice: toggle mute (session)",
    keywords: "silence quiet this session",
    input: "toggle session",
    clients: ["gui", "tui"],
  },
  {
    id: "mute-project",
    title: "Voice: toggle mute (project)",
    keywords: "silence quiet project",
    input: "toggle project",
    clients: ["gui", "tui"],
  },
  {
    id: "mute-global",
    title: "Voice: toggle mute (all)",
    keywords: "silence quiet everything global",
    input: "toggle global",
    clients: ["gui", "tui"],
  },
  {
    id: "sidebar",
    title: "Voice: toggle audio sidebar",
    keywords: "panel show hide sidebar",
    input: "sidebar",
    clients: ["tui"],
  },
  {
    id: "purge-old",
    title: "Voice: purge audio older than retention",
    keywords: "cleanup delete cache files",
    input: "purge",
    clients: ["gui", "tui"],
  },
  {
    id: "purge-all",
    title: "Voice: purge all generated audio",
    keywords: "wipe destructive cache files",
    input: "purge 0",
    clients: ["gui", "tui"],
  },
]

export function parseVoiceInput(input?: string): { verb: string; arg?: string; parts: string[] } {
  const parts = (input ?? "").trim().split(/\s+/).filter(Boolean)
  return { verb: (parts[0] ?? "").toLowerCase(), arg: parts[1]?.toLowerCase(), parts }
}
