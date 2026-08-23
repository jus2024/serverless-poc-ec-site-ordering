import { type ClientSchema, a, defineData } from "@aws-amplify/backend";

/**
 * データモデル定義
 *
 * プロジェクトに合わせてスキーマを編集してください。
 * 参考: https://docs.amplify.aws/nextjs/build-a-backend/data/
 */
const schema = a.schema({
  // サンプルモデル（プロジェクトに合わせて置き換えてください）
  Todo: a
    .model({
      content: a.string(),
      isDone: a.boolean().default(false),
    })
    .authorization((allow) => [allow.publicApiKey()]),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "apiKey",
    // API キーの有効期限（本番環境では認証方式を見直してください）
    apiKeyAuthorizationMode: {
      expiresInDays: 30,
    },
  },
});
