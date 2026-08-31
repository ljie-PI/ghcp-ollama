import {
  isWireJsonArray,
  isWireJsonObject,
  serializeWireJson,
  type WireJson,
  type WireJsonObject,
} from "./wire_json.js";

export function canonicalizeWireJson(value: WireJson): Uint8Array {
  return serializeWireJson(canonicalizeValue(value));
}

function canonicalizeValue(value: WireJson): WireJson {
  if (isWireJsonArray(value)) {
    return {
      kind: "array",
      items: value.items.map((item) => canonicalizeValue(item)),
    };
  }

  if (isWireJsonObject(value)) {
    return canonicalizeObject(value);
  }

  return value;
}

function canonicalizeObject(value: WireJsonObject): WireJsonObject {
  const ranked = value.members.map((member, index) => ({ member, index }));
  ranked.sort((left, right) => {
    const compared = compareUnicodeCodePoints(left.member.key, right.member.key);
    return compared === 0 ? left.index - right.index : compared;
  });

  return {
    kind: "object",
    members: ranked.map(({ member }) => ({
      key: member.key,
      value: canonicalizeValue(member.value),
    })),
  };
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftCodes = codePoints(left);
  const rightCodes = codePoints(right);
  const length = Math.min(leftCodes.length, rightCodes.length);

  for (let index = 0; index < length; index += 1) {
    const leftCode = leftCodes[index] ?? 0;
    const rightCode = rightCodes[index] ?? 0;
    if (leftCode !== rightCode) {
      return leftCode < rightCode ? -1 : 1;
    }
  }

  return leftCodes.length - rightCodes.length;
}

function codePoints(value: string): readonly number[] {
  const points: number[] = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined) {
      points.push(codePoint);
    }
  }
  return points;
}
