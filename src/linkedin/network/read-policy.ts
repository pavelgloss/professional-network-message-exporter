export function isAllowedLinkedInReadPath(pathname: string): boolean {
  return /^\/voyager\/api\/messaging(?:\/|$)/i.test(pathname)
    || /^\/voyager\/api\/graphql(?:\/|$)/i.test(pathname)
    || /^\/voyager\/api\/voyagerMessagingGraphQL\/graphql$/i.test(pathname)
    || /^\/voyager\/api\/me$/i.test(pathname);
}
