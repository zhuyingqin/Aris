import type { ChatTurn } from "../types";
import { parseToolBlockObject, textFromTurn } from "./model";

// Parsing and geometry for the image node canvas. Keeping it out of the panel
// component lets the layout (and the lineage between versions) be unit-tested
// without rendering, and keeps the canvas free of magic numbers.

export const IMAGE_TOOL_NAME = "ChatGptWebImage";

export type ImageWorkflowStatus = "running" | "complete" | "failed";

export interface ImageWorkflowGeneration {
  id: string;
  path: string | null;
  status: ImageWorkflowStatus;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
}

export interface ImageWorkflowCall {
  id: string;
  promptNodeId: string;
  prompt: string;
  referencePaths: string[];
  /** Generations from earlier calls that this call consumed as reference images. */
  sourceIds: string[];
  aspectRatio: string | null;
  model: string | null;
  generations: ImageWorkflowGeneration[];
}

export interface ImageWorkflowNode {
  id: string;
  kind: "prompt" | "generation";
  callId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageWorkflowEdge {
  id: string;
  /** `flow` connects a prompt to its own outputs; `lineage` connects a source image to the call that reused it. */
  kind: "flow" | "lineage";
  d: string;
}

export interface ImageWorkflowLayout {
  width: number;
  height: number;
  nodes: ImageWorkflowNode[];
  edges: ImageWorkflowEdge[];
}

const NODE_WIDTH = 216;
const PROMPT_HEIGHT = 132;
const GENERATION_HEIGHT = 172;
const NODE_GAP_Y = 16;
const CALL_GAP_Y = 46;
const COLUMN_GAP = 84;
const STAGE_PADDING = 28;
const PROMPT_X = STAGE_PADDING;
const GENERATION_X = STAGE_PADDING + NODE_WIDTH + COLUMN_GAP;
const STAGE_WIDTH = GENERATION_X + NODE_WIDTH + STAGE_PADDING;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function imagePath(value: unknown): string | null {
  if (typeof value === "string") return nonEmptyString(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return nonEmptyString(record.path) ?? nonEmptyString(record.url) ?? nonEmptyString(record.src);
}

function imageRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Windows transcripts mix separators and casing for the same artifact. */
function pathKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

export function imageWorkflowCallsFromTurns(turns: ChatTurn[]): ImageWorkflowCall[] {
  const calls: ImageWorkflowCall[] = [];
  const generationIdByPath = new Map<string, string>();
  let latestUserPrompt = "";
  for (const turn of turns) {
    if (turn.role === "user") latestUserPrompt = textFromTurn(turn).trim();
    for (let blockIndex = 0; blockIndex < turn.blocks.length; blockIndex += 1) {
      const block = turn.blocks[blockIndex];
      if (block.kind !== "tool" || block.name !== IMAGE_TOOL_NAME) continue;
      const input = parseToolBlockObject(block, "input");
      const output = parseToolBlockObject(block, "output");
      const baseId = `${turn.id}-${block.id ?? blockIndex}`;
      const images = Array.isArray(output?.images) ? output.images : [];
      const artifacts = images.flatMap((image) => {
        const path = imagePath(image);
        return path ? [{ path, record: imageRecord(image) }] : [];
      });
      const references = Array.isArray(input?.files)
        ? input.files.flatMap((file) => {
          const path = imagePath(file);
          return path ? [path] : [];
        })
        : [];
      const status: ImageWorkflowStatus = block.output === undefined
        ? "running"
        : block.isError || artifacts.length === 0
          ? "failed"
          : "complete";
      const generations: ImageWorkflowGeneration[] = artifacts.length > 0
        ? artifacts.map(({ path, record }, imageIndex) => ({
          id: `${baseId}-image-${imageIndex}`,
          path,
          status,
          width: finiteNumber(record.width),
          height: finiteNumber(record.height),
          sizeBytes: finiteNumber(record.sizeBytes),
        }))
        : [{ id: `${baseId}-output`, path: null, status, width: null, height: null, sizeBytes: null }];
      calls.push({
        id: baseId,
        promptNodeId: `${baseId}-prompt`,
        prompt: nonEmptyString(input?.prompt) ?? latestUserPrompt,
        referencePaths: references,
        sourceIds: references.flatMap((path) => {
          const sourceId = generationIdByPath.get(pathKey(path));
          return sourceId ? [sourceId] : [];
        }),
        aspectRatio: nonEmptyString(input?.aspectRatio),
        model: nonEmptyString(input?.model),
        generations,
      });
      for (const generation of generations) {
        if (generation.path) generationIdByPath.set(pathKey(generation.path), generation.id);
      }
    }
  }
  return calls;
}

function flowEdge(prompt: ImageWorkflowNode, generation: ImageWorkflowNode): string {
  const startX = prompt.x + prompt.width;
  const startY = prompt.y + prompt.height / 2;
  const endY = generation.y + generation.height / 2;
  const bend = COLUMN_GAP / 2;
  return `M${startX} ${startY} C${startX + bend} ${startY} ${generation.x - bend} ${endY} ${generation.x} ${endY}`;
}

/** Lineage runs backwards: a finished image feeds the prompt of a later call. */
function lineageEdge(source: ImageWorkflowNode, prompt: ImageWorkflowNode): string {
  const startX = source.x + source.width / 2;
  const startY = source.y + source.height;
  const endX = prompt.x + prompt.width / 2;
  const bend = Math.max(28, (prompt.y - startY) / 2);
  return `M${startX} ${startY} C${startX} ${startY + bend} ${endX} ${prompt.y - bend} ${endX} ${prompt.y}`;
}

export function layoutImageWorkflow(calls: ImageWorkflowCall[]): ImageWorkflowLayout {
  const nodes: ImageWorkflowNode[] = [];
  const edges: ImageWorkflowEdge[] = [];
  const nodeById = new Map<string, ImageWorkflowNode>();
  let cursorY = STAGE_PADDING;

  for (const call of calls) {
    const stackHeight = call.generations.length * (GENERATION_HEIGHT + NODE_GAP_Y) - NODE_GAP_Y;
    const blockHeight = Math.max(PROMPT_HEIGHT, stackHeight);
    const prompt: ImageWorkflowNode = {
      id: call.promptNodeId,
      kind: "prompt",
      callId: call.id,
      x: PROMPT_X,
      y: cursorY + (blockHeight - PROMPT_HEIGHT) / 2,
      width: NODE_WIDTH,
      height: PROMPT_HEIGHT,
    };
    nodes.push(prompt);
    nodeById.set(prompt.id, prompt);

    const stackTop = cursorY + (blockHeight - stackHeight) / 2;
    call.generations.forEach((generation, index) => {
      const node: ImageWorkflowNode = {
        id: generation.id,
        kind: "generation",
        callId: call.id,
        x: GENERATION_X,
        y: stackTop + index * (GENERATION_HEIGHT + NODE_GAP_Y),
        width: NODE_WIDTH,
        height: GENERATION_HEIGHT,
      };
      nodes.push(node);
      nodeById.set(node.id, node);
      edges.push({ id: `flow-${node.id}`, kind: "flow", d: flowEdge(prompt, node) });
    });

    for (const sourceId of call.sourceIds) {
      const source = nodeById.get(sourceId);
      if (source) edges.push({ id: `lineage-${sourceId}-${call.id}`, kind: "lineage", d: lineageEdge(source, prompt) });
    }

    cursorY += blockHeight + CALL_GAP_Y;
  }

  return {
    width: STAGE_WIDTH,
    height: Math.max(STAGE_PADDING * 2, cursorY - CALL_GAP_Y + STAGE_PADDING),
    nodes,
    edges,
  };
}

export function formatImageMeta(generation: ImageWorkflowGeneration): string | null {
  const parts: string[] = [];
  if (generation.width && generation.height) parts.push(`${generation.width}×${generation.height}`);
  if (generation.sizeBytes) {
    const kilobytes = generation.sizeBytes / 1024;
    parts.push(kilobytes >= 1024 ? `${(kilobytes / 1024).toFixed(1)} MB` : `${Math.round(kilobytes)} KB`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
