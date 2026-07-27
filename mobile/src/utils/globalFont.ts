import {Text, StyleSheet} from 'react-native';

/**
 * 全局字号缩放：patch RN Text 的 render，在渲染时把显式 fontSize/lineHeight
 * 乘上当前缩放倍数（未写 fontSize 的嵌套 Text 继承父级，不处理）。
 * 倍数变化后由 ThemeContext 更新触发全树重渲染生效。
 */
let scale = 1;

export function setGlobalFontScale(s: number) {
  scale = s;
}

export function getGlobalFontScale() {
  return scale;
}

const AnyText = Text as any;
if (!AnyText.__fontScalePatched && typeof AnyText.render === 'function') {
  AnyText.__fontScalePatched = true;
  const origRender = AnyText.render;
  AnyText.render = function (props: any, ref: any) {
    if (scale !== 1 && props?.style) {
      const flat: any = StyleSheet.flatten(props.style);
      if (flat && typeof flat.fontSize === 'number') {
        const patch: any = {fontSize: flat.fontSize * scale};
        if (typeof flat.lineHeight === 'number') {
          patch.lineHeight = flat.lineHeight * scale;
        }
        props = {...props, style: [props.style, patch]};
      }
    }
    return origRender.call(this, props, ref);
  };
}
