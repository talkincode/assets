/** Vite's `?raw` imports, used to load schema.sql into the test database. */
declare module '*.sql?raw' {
  const content: string;
  export default content;
}
