/** Split a `owner/name` repository string, as the API client's paths need it. */
export function splitForgejoRepository(repository: string): [string, string] {
  const separator = repository.indexOf("/");
  if (separator <= 0 || separator === repository.length - 1) {
    throw new Error(`forgejo repository must be owner/name: ${repository}`);
  }
  return [repository.slice(0, separator), repository.slice(separator + 1)];
}
