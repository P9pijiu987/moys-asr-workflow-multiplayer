// multiplayer-style: [multiplayer] 分组样式在 ASS 导出中的解析；依赖由 editor-utils.js 注入。
// 每个分组导出一行独立 Style（MP01…MP12）。第 1 阶段只替换外观：
// 字体、字号、颜色、描边、阴影等取分组样式，位置（对齐与边距）仍沿用原角色样式，
// 槽位排版在第 3 阶段由 multiplayer-layout 接管。
export function createUtilsModule(dependencies) {
  'use strict';
  const { ASS_REFERENCE_PLAY_RES_Y, assStyleLine, normalizeAssFontSize, normalizeAssStyle } = dependencies;

  const MULTIPLAYER_POSITION_FIELDS = Object.freeze(['alignment', 'marginL', 'marginR', 'marginV']);

  function multiplayerStyleName(index) {
    return `MP${String(index + 1).padStart(2, '0')}`;
  }

  function withRolePosition(groupStyle, roleStyle) {
    const style = { ...groupStyle };
    if (roleStyle) MULTIPLAYER_POSITION_FIELDS.forEach((field) => {
      if (roleStyle[field] !== undefined) style[field] = roleStyle[field];
    });
    return style;
  }

  // 多人模式关闭、数据缺失或不在 ASS 方案模式时返回 null，导出走上游原路径。
  function createMultiplayerAssContext(data, { resolutionHeight = ASS_REFERENCE_PLAY_RES_Y } = {}) {
    if (!data || data.enabled !== true || !Array.isArray(data.groups) || !data.groups.length) return null;
    const height = Number(resolutionHeight) > 0 ? Number(resolutionHeight) : ASS_REFERENCE_PLAY_RES_Y;
    const groups = data.groups.map((group, index) => {
      const style = normalizeAssStyle(group?.style, undefined, `mp-g${String(index + 1).padStart(2, '0')}`);
      return {
        index,
        id: group?.id,
        speaker: typeof group?.speaker === 'string' ? group.speaker : '',
        style,
        styleName: multiplayerStyleName(index),
        // 样式库字号按 1080p 参考存储，导出按 PlayResY 换算（与主样式规则一致）。
        fontSize: normalizeAssFontSize(style.fontSize * height / ASS_REFERENCE_PLAY_RES_Y),
      };
    });
    const resolve = dependencies.resolveMultiplayerGroupIndex;
    return Object.freeze({
      groups,
      cueStyle(track, segment, trackSegments, roleStyle) {
        const group = groups[resolve(data, track, segment, trackSegments)] || groups[0];
        return {
          group,
          style: withRolePosition(group.style, roleStyle),
          styleName: group.styleName,
          fontSize: group.fontSize,
          speaker: group.speaker,
        };
      },
      styleLines(baseStyle) {
        return groups.map((group) => assStyleLine(withRolePosition(group.style, baseStyle), group.styleName, group.fontSize));
      },
    });
  }

  const MULTIPLAYER_AVATAR_SECTION = '[MAW Multiplayer Avatars]';

  const MULTIPLAYER_ASSET_SECTION = '[MAW Multiplayer Assets]';

  function formatNumber(value) {
    return String(Number(Number(value).toFixed(2)));
  }

  // 把头像落点与所需图片写进 ASS 的两个自定义节。libass 与常见播放器忽略不认识的节；
  // 实际画面预览与烧录读取同一份文本，用 Pillow + ffmpeg overlay 叠加头像。
  function multiplayerAvatarSections(placements, assets) {
    const list = Array.isArray(placements) ? placements : [];
    if (!list.length) return [];
    const used = [...new Set(list.map((placement) => placement.assetId))].filter((id) => assets?.[id]?.data);
    if (!used.length) return [];
    const usedSet = new Set(used);
    const shadow = (value) => (value
      ? [value.color, value.opacity, value.blur, value.x, value.y].map((part) => (typeof part === 'number' ? formatNumber(part) : part)).join(':')
      : '-');
    return [
      MULTIPLAYER_AVATAR_SECTION,
      '; MAW Multiplayer: avatar overlays for burn-in and actual-frame preview; other players ignore this section.',
      'Format: Start, End, Asset, X, Y, Size, Opacity, Shape, Radius, Layer, FadeIn, FadeOut, Shadow',
      ...list.filter((placement) => usedSet.has(placement.assetId)).map((placement) => `Avatar: ${[
        Math.round(placement.start), Math.round(placement.end), placement.assetId,
        formatNumber(placement.x), formatNumber(placement.y), formatNumber(placement.size),
        Math.round(placement.opacity), placement.shape, formatNumber(placement.radius), placement.layer,
        placement.fadeIn || 0, placement.fadeOut || 0, shadow(placement.shadow),
      ].join(',')}`),
      '',
      MULTIPLAYER_ASSET_SECTION,
      'Format: Asset, Mime, Data',
      ...used.map((id) => `Asset: ${id},${assets[id].mime},${assets[id].data}`),
      '',
    ];
  }

  return Object.freeze({ MULTIPLAYER_ASSET_SECTION, MULTIPLAYER_AVATAR_SECTION, createMultiplayerAssContext,
    multiplayerAvatarSections, multiplayerStyleName });
}
