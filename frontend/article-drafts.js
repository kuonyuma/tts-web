/** Stable refresh identity, with a live-tab probe because duplicate tabs copy sessionStorage. */
export async function claimDraftOwner() {
  let owner;
  try {
    owner = sessionStorage.getItem('tts_article_draft_owner') || crypto.randomUUID();
    sessionStorage.setItem('tts_article_draft_owner', owner);
  } catch { owner = crypto.randomUUID(); }
  if (typeof BroadcastChannel === 'undefined') return { owner, dispose() {} };
  const channel = new BroadcastChannel('tts_article_draft_owners');
  const nonce = crypto.randomUUID();
  let probing = true;
  channel.onmessage = ({ data }) => {
    if (data?.owner !== owner) return;
    if (data.type === 'probe') channel.postMessage({ type: 'present', owner, nonce: data.nonce });
    if (probing && data.type === 'present' && data.nonce === nonce) {
      owner = crypto.randomUUID();
      try { sessionStorage.setItem('tts_article_draft_owner', owner); } catch { /* current page still isolated */ }
    }
  };
  channel.postMessage({ type: 'probe', owner, nonce });
  await new Promise(resolve => setTimeout(resolve, 80));
  probing = false;
  return { owner, dispose: () => channel.close() };
}
