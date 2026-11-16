/**
 * Name Utility Functions
 * 
 * Helper functions for processing user names
 */

/**
 * Extract first name from a full name string
 * @param fullName - The full name string
 * @returns The first name (first word)
 */
export function getFirstName(fullName: string): string {
    if (!fullName || typeof fullName !== 'string') {
        return '';
    }

    const trimmed = fullName.trim();
    const parts = trimmed.split(/\s+/);

    return parts[0] || '';
}

/**
 * Values that mean "no real name saved" — the DB defaults an empty profile
 * name to 'User', and legacy code stored the literal fallback 'there'.
 */
function isPlaceholderName(value: string): boolean {
    const t = value.trim().toLowerCase();
    return t === '' || t === 'user' || t === 'there';
}

/**
 * Resolve the user's display first name from every known source, in priority
 * order: DB profile name → auth metadata full_name/name → given+family name.
 * Returns '' when no real name exists anywhere (e.g. Apple sign-in with
 * "Hide My Name" and onboarding not yet completed).
 */
export function resolveFirstName(
    profileName: string | null | undefined,
    userMetadata: Record<string, any> | null | undefined
): string {
    const meta = userMetadata ?? {};
    const candidates = [
        profileName,
        meta.full_name,
        meta.name,
        [meta.given_name, meta.family_name].filter(Boolean).join(' '),
    ].filter((v): v is string => typeof v === 'string' && !isPlaceholderName(v));
    const first = candidates.length > 0 ? getFirstName(candidates[0]) : '';
    return isPlaceholderName(first) ? '' : first;
}
