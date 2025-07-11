import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

export default {
  input: 'src/index.js',
  output: {
    file: 'dist/server_control.js',
    format: 'cjs',
    exports: 'named',
  },
  plugins: [
    resolve(),
    commonjs(),
  ],
  external: [
    /node_modules/,
  ],
  treeshake: 'smallest',
};
