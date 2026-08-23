import { defineAuth } from "@aws-amplify/backend";

/**
 * 認証リソース定義
 *
 * プロジェクトに合わせて認証設定を編集してください。
 * 参考: https://docs.amplify.aws/nextjs/build-a-backend/auth/
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
  },
});
