import { z } from 'zod';
import type { Request, Response, NextFunction } from 'express';

type ValidationTarget = 'body' | 'query' | 'params';

export const validate = (schema: z.ZodSchema, target: ValidationTarget = 'body') =>
  (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.issues.map(i => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    // Replace with parsed (coerced/transformed) data
    req[target] = result.data;
    next();
  };
