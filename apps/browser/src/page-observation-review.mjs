import { randomUUID } from 'node:crypto';

const SELECTED_TEXT = `(() => ({
  title: document.title.slice(0, 200),
  text: (window.getSelection()?.toString() || '').trim().slice(0, 4000)
}))()`;
const REVIEW_TTL_MS = 5 * 60_000;

export function createPageObservationReview({ getActiveTab, getActiveProject, credentials, core }) {
  let pending;

  return {
    async preview(tabId) {
      pending = undefined;
      credentials();
      const tab = getActiveTab();
      const project = getActiveProject();
      const contents = tab?.view.webContents;
      if (!tab || tab.id !== tabId || tab.project !== project || tab.private || tab.loading ||
          !contents || contents.isDestroyed() || contents.isCrashed()) {
        throw new Error('Atver projekta tīmekļa cilni un iezīmē tekstu.');
      }
      const before = contents.getURL();
      const source = new URL(before);
      const url = source.origin;
      const selection = await contents.executeJavaScriptInIsolatedWorld(1000, [{ code: SELECTED_TEXT }]);
      if (getActiveTab() !== tab || getActiveProject() !== project || contents.isDestroyed() ||
          contents.isCrashed() || contents.getURL() !== before || tab.loading) {
        throw new Error('Cilne mainījās. Iezīmē tekstu vēlreiz.');
      }
      if (!selection?.text) throw new Error('Vispirms iezīmē lapas tekstu.');
      const draft = { requestId: randomUUID(), project, url, title: selection.title.trim() || source.hostname, text: selection.text };
      pending = { draft, expiresAt: Date.now() + REVIEW_TTL_MS };
      return draft;
    },

    async save(requestId) {
      const review = pending;
      if (!review || review.draft.requestId !== requestId || review.expiresAt <= Date.now() ||
          review.draft.project !== getActiveProject()) {
        throw new Error('Pārskatīšanas sesija ir beigusies. Iezīmē tekstu vēlreiz.');
      }
      const receipt = await core.saveBrowserObservation({ ...credentials(), ...review.draft });
      if (pending === review) pending = undefined;
      return receipt;
    },

    discard(requestId) {
      if (pending?.draft.requestId === requestId) pending = undefined;
    },

    list(project, q) {
      if (project !== getActiveProject()) throw new Error('Projekts mainījās.');
      return core.listBrowserObservations({ ...credentials(), project, q });
    },

    delete(project, id) {
      if (project !== getActiveProject()) throw new Error('Projekts mainījās.');
      return core.deleteBrowserObservation({ ...credentials(), project, id });
    }
  };
}
