// Point every test at isolated resources so running tests never touches your demo data.
// Deliberately overwrite (not ??=) so a DATABASE_URL exported in your shell can't leak in.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://flashsale:flashsale@localhost:5432/flashsale_test';
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';
process.env.QUEUE_NAME = 'reservations-test';
process.env.LOG_EVENTS = 'off';
process.env.NODE_ENV = 'test';
