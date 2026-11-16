import { create } from 'zustand';

import type { NutritionClarification } from '../src/api/backendClient';

/**
 * One-shot handoff from the photo-log route back to the nutrition tab.
 *
 * When a photo analysis carried a clarification and the user logged without
 * fixing it, the pills should attach to the new row in the meal list exactly
 * like typed logs (PRD §4.5). The photo-log screen can't pass params on
 * router.back(), so it drops the payload here and the nutrition tab consumes
 * it on focus.
 */
type PhotoLogHandoff = {
  pending: { logId: string; clarification: NutritionClarification } | null;
  set: (payload: { logId: string; clarification: NutritionClarification }) => void;
  /** Returns and clears the pending payload (one-shot). */
  consume: () => { logId: string; clarification: NutritionClarification } | null;
};

export const usePhotoLogHandoff = create<PhotoLogHandoff>((set, get) => ({
  pending: null,
  set: (payload) => set({ pending: payload }),
  consume: () => {
    const current = get().pending;
    if (current) set({ pending: null });
    return current;
  },
}));
