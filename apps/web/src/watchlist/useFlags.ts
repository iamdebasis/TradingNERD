import type { FlagState } from '@tradingnerd/core';
import { flagsApi } from '../data/api';
import { type DocumentApi, useSavedDocument } from '../lib/useSavedDocument';

/** Wait before asking the gateway for the flags again after a failure. */
export const FLAGS_RETRY_MS = 3_000;

/** The flags, loaded from the gateway and saved back after every edit (useSavedDocument). */
export function useFlags(api: DocumentApi<FlagState> = flagsApi) {
  const { doc, edit } = useSavedDocument(api, FLAGS_RETRY_MS);
  return { flags: doc, editFlags: edit };
}
