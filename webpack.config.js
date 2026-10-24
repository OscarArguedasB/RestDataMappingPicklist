const path = require('node:path');
const { EsbuildPlugin } = require('esbuild-loader');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

// Endpoints are configured per process, so any HTTPS origin has to be reachable.
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  // The DevOps SDK applies the user's theme through an inline <style> element.
  "style-src 'self' 'unsafe-inline'",
  'connect-src https: http://localhost:* http://127.0.0.1:*',
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const PAGES = [
  { name: 'selector', entry: './src/control/index.tsx', title: 'REST picklist' },
  { name: 'configurator', entry: './src/configurator/index.tsx', title: 'REST picklist setup' },
];

// A local page with a simulated work item form; never shipped in the production package.
const PLAYGROUND = {
  name: 'playground',
  entry: './src/playground/index.tsx',
  title: 'REST picklist playground',
};

module.exports = (env = {}, argv = {}) => {
  const production = argv.mode === 'production';
  const pages = production ? PAGES : [...PAGES, PLAYGROUND];

  return {
    mode: production ? 'production' : 'development',
    entry: Object.fromEntries(pages.map((page) => [page.name, page.entry])),
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: production ? '[name].[contenthash:8].js' : '[name].js',
      publicPath: '',
      clean: true,
    },
    devtool: production ? false : 'source-map',
    resolve: {
      extensions: ['.ts', '.tsx', '.js'],
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          loader: 'esbuild-loader',
          exclude: /node_modules/,
          options: { target: 'es2022' },
        },
        {
          test: /\.css$/,
          use: [MiniCssExtractPlugin.loader, 'css-loader'],
        },
      ],
    },
    optimization: {
      // One shared vendor chunk (React, SDK); each page otherwise loads a single script and
      // stylesheet, which keeps the work item form's iframe to three requests.
      splitChunks: {
        chunks: 'all',
        cacheGroups: {
          default: false,
          defaultVendors: false,
          vendor: { test: /[\\/]node_modules[\\/]/, name: 'vendor', chunks: 'all' },
          // What the control loads later (its configuration, the policy, 3.0 saved
          // configurations) shares the REST client, extension data, processes and
          // configurations: one chunk holds them instead of a copy in each lazy chunk.
          lazyShared: {
            test: /[\\/]src[\\/]/,
            name: 'lazy-shared',
            chunks: 'async',
            minChunks: 2,
            minSize: 0,
            priority: -10,
          },
        },
      },
      minimizer: [new EsbuildPlugin({ target: 'es2022', css: true })],
    },
    performance: {
      hints: production ? 'warning' : false,
      // Budgets for what every work item form downloads before the control shows: the vendor
      // chunk, the control's script and its stylesheet. The setup page is an admin page under
      // Organization settings, so its own files aren't held to them.
      assetFilter: (file) => /\.(js|css)$/.test(file) && !file.startsWith('configurator.'),
      maxAssetSize: 250_000,
      maxEntrypointSize: 350_000,
    },
    plugins: [
      new MiniCssExtractPlugin({
        filename: production ? '[name].[contenthash:8].css' : '[name].css',
      }),
      ...pages.map(
        (page) =>
          new HtmlWebpackPlugin({
            template: 'src/page.html',
            filename: `${page.name}.html`,
            chunks: [page.name],
            title: page.title,
            csp: production ? CONTENT_SECURITY_POLICY : '',
          })
      ),
    ],
    devServer: env.playground
      ? {
          port: 3000,
          open: ['/dist/playground.html'],
          devMiddleware: { publicPath: '/dist/' },
          static: false,
        }
      : {
          server: 'https',
          port: 44300,
          devMiddleware: { publicPath: '/dist/' },
          static: false,
        },
  };
};
