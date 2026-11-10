import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const modelPath = fileURLToPath(new URL('../../retailpulse-frontend/public/retailpulse-model.json', import.meta.url));

const contentModelSchema = z
  .object({
    version: z.number().int().positive(),
    appId: z.literal('retailpulse'),
    locale: z.string().min(2),
    messages: z.record(z.string(), z.unknown()),
    data: z
      .object({
        app: z.object({
          name: z.string(),
          descriptor: z.string(),
          description: z.string(),
          apiBaseUrl: z.string().url(),
          allowedOrigins: z.array(z.string().url()).min(1),
          currency: z.string(),
          timezone: z.string(),
          exportFilename: z.string(),
        }),
        theme: z.object({
          storageKey: z.string(),
          default: z.enum(['light', 'dark']),
        }),
        navigation: z.array(
          z.object({
            id: z.enum(['overview', 'revenue', 'stores', 'products', 'alerts', 'settings']),
            label: z.string(),
            icon: z.string(),
          }),
        ),
        filters: z.object({
          defaultRangeId: z.string(),
          ranges: z.array(z.object({ id: z.string(), label: z.string(), days: z.number() })),
          categories: z.array(z.object({ id: z.string(), label: z.string(), color: z.string() })),
        }),
        validation: z.object({
          maximumRequestBytes: z.number(),
          minimumAlertThreshold: z.number(),
          maximumAlertThreshold: z.number(),
          maximumActivityItems: z.number(),
        }),
        reports: z.object({
          recordTypes: z.object({
            store: z.string(),
            product: z.string(),
          }),
          csvHeaders: z.array(z.string()),
        }),
        seed: z
          .object({
            version: z.number().int().positive(),
            stores: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                city: z.string(),
                region: z.string(),
                format: z.string(),
                squareFeet: z.number(),
                displayOrder: z.number(),
              }),
            ),
            products: z.array(
              z.object({
                id: z.string(),
                sku: z.string(),
                name: z.string(),
                category: z.string(),
                unitPriceCents: z.number(),
                unitCostCents: z.number(),
                stockOnHand: z.number(),
                displayOrder: z.number(),
              }),
            ),
            alerts: z.array(
              z.object({
                id: z.string(),
                title: z.string(),
                description: z.string(),
                metricKey: z.string(),
                operator: z.string(),
                threshold: z.number(),
                unit: z.string(),
                severity: z.enum(['high', 'medium', 'low']),
                enabled: z.boolean(),
                displayOrder: z.number(),
              }),
            ),
            patterns: z.array(
              z.object({
                storeId: z.string(),
                productId: z.string(),
                units: z.number(),
                hour: z.number(),
                channel: z.string(),
              }),
            ),
            salesDays: z.number().int().positive(),
            maxUnitsVariation: z.number().int().positive(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export function loadModel() {
  const rawModel = JSON.parse(readFileSync(modelPath, 'utf8'));
  const envelope = contentModelSchema.parse(rawModel);
  return {
    modelVersion: envelope.version,
    app: { ...envelope.data.app, locale: envelope.locale },
    theme: envelope.data.theme,
    navigation: envelope.data.navigation,
    copy: envelope.messages,
    filters: envelope.data.filters,
    validation: envelope.data.validation,
    reports: envelope.data.reports,
    seed: envelope.data.seed,
  };
}
