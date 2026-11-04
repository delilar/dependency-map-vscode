declare module 'parse-srcset' {
  const parse: (input: string) => { url: string; w?: number; h?: number; d?: number }[];
  export default parse;
}
