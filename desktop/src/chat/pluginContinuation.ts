import type { ChatBlock, ChatTurn } from "../types";
import type { Language } from "../store";

/**
 * After the user approves a plugin on a `PluginManager` card, the change only
 * applies from the next turn: MCP tools are attached and the plugin set is
 * frozen when a turn starts. So the app runs exactly one more turn by itself,
 * in which the agent verifies the plugin, instead of waiting for the user to
 * type "continue". That turn is marked as the app's, never as the user's.
 */
export const PLUGIN_CONTINUATION_ORIGIN = "plugin-continuation";

/** A user-role turn the app inserted rather than one the user wrote. */
export function isAppInsertedTurn(turn: ChatTurn): boolean {
  return turn.role === "user" && turn.origin !== undefined;
}

/** The user's own questions: what titles and project intent are read from. */
export function isUserQuestion(turn: ChatTurn): boolean {
  return turn.role === "user" && !isAppInsertedTurn(turn);
}

function approvedOnCard(block: ChatBlock): boolean {
  if (block.kind !== "tool" || block.name !== "PluginManager" || block.isError) return false;
  // Only a card the user answered counts, and only one that makes something
  // new run: verifying a removal has nothing to exercise.
  const card = block.pluginApproval;
  if (!card || card.kind === "remove" || block.output == null) return false;
  try {
    return (JSON.parse(block.output) as { application?: unknown }).application === "next-turn";
  } catch {
    return false;
  }
}

/**
 * Whether the turn that just finished should be followed by one verification
 * turn: it ended normally, the user approved enabling or upgrading a plugin on
 * one of its cards, and it was not itself such a follow-up (one per approval,
 * never a chain).
 */
export function needsPluginContinuation(turns: ChatTurn[]): boolean {
  const last = turns[turns.length - 1];
  if (!last || last.role !== "assistant" || last.streaming || last.error || last.stopped) return false;
  const asked = turns[turns.length - 2];
  if (asked && asked.origin === PLUGIN_CONTINUATION_ORIGIN) return false;
  return last.blocks.some(approvedOnCard);
}

/** What the model is told at the start of the follow-up turn. */
export function pluginContinuationPrompt(): string {
  return [
    "[SomniQ] The user approved the plugin change in the previous turn, and it is active from this turn.",
    "Verify it as the somniq-plugin-development skill says: call PluginManager list and confirm the package's lifecycle state;",
    "then use it the way the user will (call its new mcp__ tools, load its skill, or tell the user where its Chat sidebar panel is).",
    "PluginManager is the authority on plugin state: do not read SomniQ's configuration, plugin store or session files (for example under ~/.config/SomniQ) to verify it, and do not open other conversations.",
    "Report what worked, what you could not verify, and where the draft is. Change the plugin only if verification shows a defect.",
    "Answer in the language of the conversation.",
  ].join("\n");
}

/** The marker shown in place of a user message. */
export function pluginContinuationLabel(language: Language): string {
  return language === "cn" ? "插件已启用，继续验证" : "Plugin enabled · verifying it";
}
