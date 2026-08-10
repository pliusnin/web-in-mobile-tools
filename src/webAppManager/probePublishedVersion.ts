const ZIP_CONTENT_TYPES = ['application/zip', 'application/x-zip-compressed'];

/**
 * Default "is a newer archive published?" probe: a `HEAD` request whose
 * `last-modified` header is the publication date.
 *
 * Resolves `null` — meaning "nothing usable published here" — when the request
 * fails, when the response does not look like a zip (a server answering an error
 * page with HTTP 200 included), or when there is no usable `last-modified`.
 *
 * Header lookup goes through the `Headers` API, which is case-insensitive; the
 * casing of response headers is not consistent across platforms and clients.
 */
export const probePublishedVersion = async (
  zipUrl: string,
): Promise<Date | null> => {
  const response = await fetch(zipUrl, { method: 'HEAD' });

  if (!response.ok) {
    return null;
  }

  const contentType = (
    response.headers.get('content-type') ?? ''
  ).toLowerCase();

  if (!ZIP_CONTENT_TYPES.some(type => contentType.includes(type))) {
    return null;
  }

  const lastModified = response.headers.get('last-modified');

  if (!lastModified) {
    return null;
  }

  const publishedAt = new Date(lastModified).valueOf();

  return Number.isFinite(publishedAt) && publishedAt > 0
    ? new Date(publishedAt)
    : null;
};
