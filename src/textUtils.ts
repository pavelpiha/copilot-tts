/**
 * Strip markdown formatting from text so TTS output sounds natural.
 */
export function stripMarkdown(text: string, readCodeBlocks = false): string {
  let result = text;

  // Code fences – read content when readCodeBlocks, otherwise drop silently
  if (readCodeBlocks) {
    result = result.replace(/```[\w]*\n?([\s\S]*?)```/g, "$1");
  } else {
    result = result.replace(/```[\w]*\n?[\s\S]*?```/g, "");
  }

  // Inline code – always keep the content (strip backticks only)
  result = result.replace(/`([^`]+)`/g, "$1");

  // ATX headers
  result = result.replace(/^#{1,6}\s+/gm, "");

  // Bold and italic  (**text**, *text*, __text__, _text_)
  result = result.replace(/\*{1,3}([^*\n]+)\*{1,3}/g, "$1");
  result = result.replace(/_{1,3}([^_\n]+)_{1,3}/g, "$1");

  // Strikethrough
  result = result.replace(/~~([^~]+)~~/g, "$1");

  // Images  ![alt](url)
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, "");

  // Links  [text](url)  →  text
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  // Horizontal rules
  result = result.replace(/^[-*_]{3,}\s*$/gm, "");

  // Blockquotes
  result = result.replace(/^>\s*/gm, "");

  // Unordered list markers
  result = result.replace(/^[-*+]\s+/gm, "");

  // Ordered list markers
  result = result.replace(/^\d+\.\s+/gm, "");

  // HTML tags
  result = result.replace(/<[^>]+>/g, "");

  // Collapse excessive blank lines
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

/**
 * Split text into sentence-sized chunks so each TTS request stays small
 * and playback can begin quickly.
 */
export function chunkText(text: string, maxLength = 400): string[] {
  // Split on sentence boundaries
  const parts = text.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";

  for (const part of parts) {
    if (current.length + part.length + 1 > maxLength && current.length > 0) {
      chunks.push(current.trim());
      current = part;
    } else {
      current += (current ? " " : "") + part;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks.filter((c) => c.length > 0);
}
