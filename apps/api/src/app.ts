import express from 'express';
import type { Express } from 'express';

// Built separately from index.ts so tests get an app without a listening port.
// Middleware and routes attach here, in the route → controller → service layering
// from apps/api/CLAUDE.md.
export function createApp(): Express {
  return express();
}
