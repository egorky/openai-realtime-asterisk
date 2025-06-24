import concurrently from 'concurrently';

await concurrently([
  {
    command: 'pnpm packages:dev',
    name: 'packages',
    prefixColor: 'auto',
  },
  {
    command: 'pnpm -F docs dev',
    name: 'docs',
    prefixColor: 'auto',
  },
]);
