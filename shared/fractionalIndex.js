// Figma記事で説明した Fractional Indexing の考え方を再現する実装。
//
// Figma公式ブログによると、実際のFigmaは兄弟要素の順序を 64bit の浮動小数点数
// ではなく「任意精度の小数を文字列として保持」する方式で管理しているとのこと。
// ここでは 0〜1 の間の小数を「小数点以下の桁の文字列」として表現し、
// 2つの値の間に新しい値を挿入するたびに、必要であれば桁を1つ伸ばして
// 精度を確保する。これにより、桁を伸ばし続ける限り
// 「どんなに詰めて挿入しても精度が枯渇しない」という性質を再現している。

const FIRST = '5'; // 0 と 1 のちょうど中間 (=0.5) を初期値として使う

function digitsToBigInt(digits) {
  return digits.length === 0 ? 0n : BigInt(digits);
}

function trimTrailingZeros(digits) {
  const trimmed = digits.replace(/0+$/, '');
  return trimmed.length === 0 ? '0' : trimmed;
}

// low, high (どちらも "小数点以下の桁" を表す文字列) の中間値を求める。
// 中間値が low または high と一致してしまう場合は、桁を1つ伸ばして
// (=10倍の精度で) 計算をやり直す。
function midpointDigits(lowDigits, highDigits) {
  let len = Math.max(lowDigits.length, highDigits.length, 1);

  for (;;) {
    const low = lowDigits.padEnd(len, '0');
    const high = highDigits.padEnd(len, '0');
    const lowInt = digitsToBigInt(low);
    const highInt = digitsToBigInt(high);
    const sum = lowInt + highInt;

    if (sum % 2n === 0n) {
      const midInt = sum / 2n;
      const mid = midInt.toString().padStart(len, '0');
      if (mid !== low && mid !== high) {
        return trimTrailingZeros(mid);
      }
    }
    // 精度が足りず中間値が求まらない場合、桁を1つ増やして再挑戦する
    len += 1;
  }
}

/**
 * a と b の間に挿入するための新しい順序キーを生成する。
 * a が null なら「先頭に挿入」、b が null なら「末尾に挿入」を意味する。
 */
export function generateKeyBetween(a, b) {
  if (a != null && b != null && a >= b) {
    throw new Error(`generateKeyBetween: a(${a}) は b(${b}) より小さくなければなりません`);
  }
  if (a == null && b == null) {
    return FIRST;
  }
  if (a == null) {
    // 0 と b の間
    return midpointDigits('', b);
  }
  if (b == null) {
    // a と 1 の間。1 を「常に a より大きい 9 の並び」として仮想的に扱う。
    const virtualHigh = '9'.repeat(a.length + 1);
    return midpointDigits(a, virtualHigh);
  }
  return midpointDigits(a, b);
}
