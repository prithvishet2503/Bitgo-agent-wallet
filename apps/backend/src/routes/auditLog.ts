import { Router } from 'express';
import { AuditLogQuerySchema } from '@bitgo-agent-wallet/shared';
import * as auditService from '../services/auditService.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const auditLogRouter = Router();

/** Section 6.8 - Audit & Compliance: query the immutable log. */
auditLogRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = AuditLogQuerySchema.parse({
      enterpriseId: req.enterpriseId!,
      subWalletId: req.query.subWalletId,
      eventType: req.query.eventType,
      from: req.query.from,
      to: req.query.to,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json(auditService.query(query));
  }),
);

/** Section 6.8 - "Logs exportable in formats compatible with existing BitGo
 * compliance reporting (CSV, API, ...)." */
auditLogRouter.get(
  '/export.csv',
  asyncHandler(async (req, res) => {
    const csv = auditService.exportCsv(req.enterpriseId!);
    res.type('text/csv').send(csv);
  }),
);
