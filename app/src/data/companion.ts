// The call every page makes to the localhost companion (dev server only): the per-process token from
// the page's meta tag, sent as a header on a same-origin JSON POST.

const token = () => document.querySelector<HTMLMetaElement>('meta[name="purser-token"]')?.content ?? null;

export const companionAvailable = (): boolean => token() !== null;

export async function companionCall(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const t = token();
  if (!t) throw new Error("companion not available");
  return fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-purser-token": t }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
}
