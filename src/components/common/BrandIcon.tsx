/**
 * ブランドアイコン（コーヒーカップ + 湯気 + 雲）。
 *
 * 画像の実体は public/brand/kiro-roasters-icon-256.png（Web 表示用の軽量版）。
 * 高解像度版は public/brand/kiro-roasters-icon.png（README / OG 画像 / 記事アイキャッチ用）。
 * ファビコンは 256 版を src/app/icon.png にコピーして配置している。
 * アイコンを差し替える際は 3 箇所すべてを更新すること。
 */
import Image from "next/image";

type BrandIconProps = {
  size?: number;
  className?: string;
};

export default function BrandIcon({ size = 20, className }: BrandIconProps) {
  return (
    <Image
      src="/brand/kiro-roasters-icon-256.png"
      alt="Kiro Roasters"
      width={size}
      height={size}
      className={className}
    />
  );
}
