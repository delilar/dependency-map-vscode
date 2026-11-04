const attributes: Record<string, readonly string[]> = {
  src: ['img', 'audio', 'video', 'source', 'script', 'iframe', 'embed', 'input', 'track'],
  srcset: ['img', 'source'],
  href: ['a', 'area', 'link', 'image', 'use'],
  'xlink:href': ['image', 'use'],
  poster: ['video'],
  data: ['object'],
};

export function nativeResourceAttribute(tag: string, attribute: string): boolean {
  if (/^[A-Z]/.test(tag)) return false;
  return attributes[attribute.toLowerCase().replace(/^xlinkhref$/, 'xlink:href')]?.includes(tag.toLowerCase()) ?? false;
}
