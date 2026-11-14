export function formatGreeting(name, suffix) {
  const parts = ['hello', String(name), suffix];
  return parts.join(' ');
}

export function describeDatabase(database, label) {
  return 'database=' + database + ' ' + label;
}
