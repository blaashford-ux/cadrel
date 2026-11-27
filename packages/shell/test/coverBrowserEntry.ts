// What the browser test loads into a real Chromium page: the designer's drawing code and its runtime, bundled together.
import * as doc from '../src/shared/cover/doc';
import * as arrange from '../src/shared/cover/arrange';
import * as fonts from '../src/shared/cover/fonts';
import * as library from '../src/shared/cover/library';
import * as render from '../src/shared/cover/render';
import * as runtime from '../src/renderer/cover/runtime';
(window as unknown as { cover: unknown }).cover = { ...doc, ...arrange, ...fonts, ...library, ...render, ...runtime };
