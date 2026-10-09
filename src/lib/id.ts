/** Random, collision-resistant id with a readable prefix (e.g. "fld_3k9x…"). */
export function newId(prefix: string): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const body = Array.from(bytes, (b) => (b % 36).toString(36)).join('');
  return `${prefix}_${body}`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
