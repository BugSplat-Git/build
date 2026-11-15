// Only `database` and `settings` read the value. Everywhere else, this comment included,
// process.env.BUGSPLAT_DATABASE is text or something that is written to.
export const label = "process.env.BUGSPLAT_DATABASE";
export const template = `€ ${'process.env.BUGSPLAT_DATABASE'} process.env.BUGSPLAT_DATABASE`;

export function setDatabase(value) {
  process.env.BUGSPLAT_DATABASE = value;
  [process.env.BUGSPLAT_DATABASE] = [value];
  ({ value: process.env.BUGSPLAT_DATABASE } = { value });
  delete process.env.BUGSPLAT_DATABASE;
}

export const database = /* 😀 */ process.env.BUGSPLAT_DATABASE;
export const settings = { database: process.env.BUGSPLAT_DATABASE, length: process.env.BUGSPLAT_DATABASE.length };
