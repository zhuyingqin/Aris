export const USER_MESSAGE_PREVIEW_LINES = 10;

export function userMessageDisclosureKey(turnId: string, blockIndex: number): string {
  return `user-text:${turnId}:${blockIndex}`;
}
