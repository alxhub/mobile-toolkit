declare var require;

var gulp = require('gulp');
var util = require('gulp-util');
var ts = require('gulp-typescript');
var Builder = require('systemjs-builder');
var fs = require('fs');
var rimraf = require('rimraf');
var concat = require('gulp-concat');
let jsmn = require('gulp-jasmine');
var runSequence = require('run-sequence');
var process = require('process');
var merge = require('merge-stream');
var exec = require('child_process').exec;
var uglify = require('gulp-uglify');
var rename = require('gulp-rename');
var rollup = require('rollup');
var nodeResolve = require('rollup-plugin-node-resolve');

class RxRewriter {

  resolveId(id, from) {
    if(id.startsWith('rxjs/')){
      return `${process.cwd()}/node_modules/rxjs-es/${id.split('rxjs/').pop()}.js`;
    }
  }
}

let assign = (dest, ...sources) => {
  sources.forEach(source => {
    Object.keys(source).forEach(key => {
      dest[key] = source[key];
    });
  });
  return dest;
}

var systemCompilerConfig = assign({}, 
  JSON.parse(fs.readFileSync('./tsconfig.json')).compilerOptions,
  {
    typescript: require('typescript')
  }
);

var commonCompilerConfig = assign({},
  systemCompilerConfig,
  {
    "module": "es6",
    "target": "es6",
    "lib": ["es6", "dom"]
  }
);

var transpilerConfig = assign({},
  systemCompilerConfig,
  {
    "target": "es5",
    "allowJs": true,
    "outFile": "dist/src/worker-transpiled.js"
  }
);

function pluginTasks(name: string) {
  gulp.task(`task:plugin_${name}:build`, done => runSequence(
    `task:plugin_${name}:compile`,
    `task:plugin_${name}:rollup`,
    done));

  gulp.task(`task:plugin_${name}:compile`, () => gulp
    .src([
      `src/plugin/${name}/**/*.ts`,
      'src/typings/**/*.d.ts',
      'typings/globals/**/*.d.ts', 
      'typings/modules/**/*.d.ts'
    ])
    .pipe(ts(commonCompilerConfig))
    .pipe(gulp.dest('dist')));

  gulp.task(`task:plugin_${name}:rollup`, done => {
    rollup.rollup({
      entry: `dist/src/plugin/${name}/index.js`,
      external: [
        'rxjs/Observable',
        'rxjs/Subject'
      ],
      plugins: [
        new RxRewriter(),
        nodeResolve({
          jsnext: true,
          main: true,
          extensions: ['.js'],
          preferBuiltins: false
        })
      ]
    }).then(bundle => bundle.write({
      format: 'cjs',
      dest: `dist/plugin/${name}.js`
    }))
    .catch(err => console.error(err))
    .then(() => done());
  });
}

gulp.task('default', ['worker:build']);

gulp.task('clean', (done) => {
  rimraf('./dist', done);
});

gulp.task('prepublish', ['build']);

gulp.task('build', done => runSequence(
  'clean',
  [
    'task:companion:build',
    'task:generator:build',
    'task:worker:build'
  ],
  done
));

gulp.task('worker:build', done => runSequence(
  'clean',
  'task:worker:build',
  done));

gulp.task('companion:build', done => runSequence(
  'clean',
  'task:companion:build',
  done));
  
gulp.task('generator:build', done => runSequence(
  'clean',
  'task:generator:build',
  done));

gulp.task('task:companion:build', done => runSequence(
  'task:companion:compile',
  'task:companion:copy_deploy',
  done));

gulp.task('task:worker:build', done => 
  runSequence(
    'task:worker:compile',
    'task:worker:rollup',
    'task:worker:transpile',
    'task:worker:pack',
    'task:worker:rewrite_modules',
    done
  ));

gulp.task('task:worker:compile_system', () => {
  const stream = gulp
    .src([
      'src/worker/**/*.ts',
      'src/typings/**/*.d.ts',
      'typings/globals/**/*.d.ts',
      'typings/modules/**/*.d.ts'
    ])
    .pipe(ts(systemCompilerConfig));
  return merge([
    stream.js.pipe(gulp.dest(systemCompilerConfig.outDir)),
    stream.dts.pipe(gulp.dest(systemCompilerConfig.outDir))
  ]);
});

gulp.task('task:worker:compile', () => {
  const stream = gulp
    .src([
      'src/worker/**/*.ts',
      'src/typings/**/*.d.ts',
      'typings/globals/**/*.d.ts', 
      'typings/modules/**/*.d.ts'
    ])
    .pipe(ts(commonCompilerConfig));
  return merge([
    stream.js.pipe(gulp.dest(commonCompilerConfig.outDir)),
    stream.dts.pipe(gulp.dest(commonCompilerConfig.outDir))
  ]);
});

gulp.task('task:worker:rollup', done => {
  rollup.rollup({
    entry: 'dist/src/worker/browser_entry.js',
    external: (id) => {
      if (id === 'jshashes' || id.substring(0, 5) == 'rxjs/') {
        return true;
      } else {
        return false;
      }
    },
    plugins: [
      //new RxRewriter(),
      nodeResolve({
        jsnext: true,
        main: true,
        extensions: ['.js'],
        preferBuiltins: false
      })
    ]
  }).then(bundle => bundle.write({
    format: 'cjs',
    dest: 'dist/src/worker-rollup.js'
  }))
  .catch(err => console.error(err))
  .then(() => done());
});

gulp.task('task:worker:concat', () => gulp
  .src([
    'node_modules/jshashes/hashes.js',
    'dist/src/worker-rollup.js'
  ])
  .pipe(concat('src/worker-concat.js'))
  .pipe(gulp.dest('dist')));

gulp.task('task:worker:transpile', () => gulp
  .src([
    'dist/src/worker-rollup.js'
  ])
  .pipe(ts(transpilerConfig))
  .pipe(gulp.dest('dist')));

pluginTasks('static');

gulp.task('task:companion:compile', () => {
  const stream = gulp
    .src([
      'src/companion/**/*.ts',
      'src/typings/**/*.d.ts',
      'typings/globals/**/*.d.ts',
      'typings/modules/**/*.d.ts'
    ])
    .pipe(ts(commonCompilerConfig));
  return merge([
    stream.js.pipe(gulp.dest(commonCompilerConfig.outDir)),
    stream.dts.pipe(gulp.dest(commonCompilerConfig.outDir))
  ]);
});

gulp.task('task:companion:copy_deploy', () => gulp
  .src([
    'dist/src/companion/**/*.js',
    'dist/src/companion/**/*.d.ts'
  ])
  .pipe(gulp.dest('dist/companion')));

gulp.task('task:worker:pack', done => {
  var builder = new Builder();
  builder.config({
    map: {
      'rxjs': 'node_modules/rxjs',
      'jshashes': 'node_modules/jshashes/hashes.js'
    },
    packages: {
      'rxjs': {
        defaultExtension: 'js'
      }
    }
  });
  builder
    .bundle('dist/src/worker-transpiled.js', 'dist/src/worker-packed.js')
    .then(() => done());
});

gulp.task('task:worker:rewrite_modules', () => systemRewriter(
  'dist/src/worker-packed.js',
  'dist/worker.js'
));

gulp.task('task:worker:minify', () => gulp
  .src([
    'dist/worker.js'
  ], {base: 'dist'})
  .pipe(uglify())
  .pipe(rename({suffix: '.min'}))
  .pipe(gulp.dest('dist')));

gulp.task('task:generator:build', done => runSequence(
  'task:generator:compile',
  'task:generator:copy_deploy',
  done));

gulp.task('task:generator:compile', () => gulp
  .src([
    'src/generator/**.ts',
    'typings/globals/**/*.d.ts',
    'typings/modules/**/*.d.ts'
  ])
  .pipe(ts(commonCompilerConfig))
  .pipe(gulp.dest('dist')));

gulp.task('task:generator:copy_deploy', () => gulp
  .src([
    'dist/src/generator/**/*.js'
  ])
  .pipe(gulp.dest('dist/generator')));

gulp.task('e2e_harness:build', done => runSequence(
  'clean',
  'task:e2e_harness:build',
  done));

gulp.task('e2e_harness:debug', done => runSequence(
  'clean',
  'task:e2e_harness:debug',
  done));

gulp.task('task:e2e_harness:build', done => runSequence([
  'task:e2e_harness:build_worker',
  'task:e2e_harness:copy_modules',
  'task:e2e_harness:copy_index',
  'task:e2e_harness:build_primary'
], done));

gulp.task('task:e2e_harness:debug', done => runSequence([
  'task:e2e_harness:build',
  'task:e2e_harness:copy_debug'
]));

gulp.task('task:e2e_harness:build_primary', done => runSequence(
  'task:companion:build',
  [
    'task:e2e_harness:compile',
    'task:e2e_harness:copy_companion'
  ],
  done));

gulp.task('task:e2e_harness:build_worker', done => runSequence(
  'task:worker:build',
  'task:e2e_harness:copy_worker',
  done));

gulp.task('task:e2e_harness:build_companion', done => runSequence(
  'task:companion:compile',
  [
    'task:e2e_harness:copy_companion',
    'task:companion:copy_deploy'
  ],
  done));

gulp.task('task:e2e_harness:compile', () => gulp
  .src([,
    'src/test/e2e/harness/client/**/*.ts',
    'typings/globals/**/*.d.ts',
    'typings/modules/**/*.d.ts'
  ], {base: '.'})
  .pipe(ts(systemCompilerConfig))
  .pipe(gulp.dest('dist')));
  
gulp.task('task:e2e_harness:copy_modules', () => gulp
  .src([
    'node_modules/@angular/**/*.js',
    'node_modules/systemjs/dist/system.js',
    'node_modules/reflect-metadata/Reflect.js',
    'node_modules/zone.js/dist/zone.js',
    'node_modules/rxjs/**/*.js',
    'node_modules/base64-js/base64js.min.js'
  ], {base: '.'})
  .pipe(gulp.dest('dist/src/test/e2e/harness/client')));

gulp.task('task:e2e_harness:copy_debug', () => gulp
  .src([
    'src/test/e2e/harness/client/debug/**/*.*'
  ], {base: 'src/test/e2e/harness/client/debug'})
  .pipe(gulp.dest('dist/src/test/e2e/harness/client')));

gulp.task('task:e2e_harness:copy_companion', () => gulp
  .src([
    'dist/src/companion/**/*.js'
  ], {base: 'dist/src'})
  .pipe(gulp.dest('dist/src/test/e2e/harness/client/node_modules/@angular/service-worker/dist')));

gulp.task('task:e2e_harness:copy_worker', () => gulp
  .src([
    'dist/worker.js',
  ], {base: 'dist'})
  .pipe(gulp.dest('dist/src/test/e2e/harness/client')));
  
gulp.task('task:e2e_harness:copy_index', () => gulp
  .src([
    'src/test/e2e/harness/client/index.html',
    'src/test/e2e/harness/client/manifest.webapp'
  ], {base: '.'})
  .pipe(gulp.dest('dist')));

gulp.task('task:e2e_tests:build', done => runSequence([
  'task:e2e_tests:compile',
  'task:e2e_tests:copy_protractor',
], done));

gulp.task('task:e2e_tests:compile', () => gulp
  .src([
    'src/test/e2e/spec/**/*.ts',
    'src/test/e2e/harness/server/**/*.ts',
    'src/typings/**/*.d.ts',
    'typings/globals/**/*.d.ts',
    'typings/modules/**/*.d.ts'
  ], {base: '.'})
  .pipe(ts(commonCompilerConfig))
  .pipe(gulp.dest('dist')));

gulp.task('task:e2e_tests:copy_protractor', () => gulp
  .src([
    'src/test/e2e/spec/protractor.config.js'
  ], {base: '.'})
  .pipe(gulp.dest('dist')));

gulp.task('task:unit_tests:compile', () => gulp
  .src([
    'src/test/unit/**/*.ts',
    'src/testing/**/*.ts',
    'src/typings/**/*.d.ts',
    'typings/globals/**/*.d.ts',
    'typings/modules/**/*.d.ts'
  ], {base: '.'})
  .pipe(ts(commonCompilerConfig))
  .pipe(gulp.dest('dist')));

gulp.task('test', done => runSequence(
  'test:unit',
  'test:e2e',
  done
));

gulp.task('test:unit', done => runSequence(
  'clean',
  [
    'task:unit_tests:compile',
    'task:worker:compile_common'
  ],
  'task:unit_tests:run',
  done
));

gulp.task('task:unit_tests:run', () => gulp
  .src([
    'dist/**/*.spec.js'
  ], {base: '.'})
  .pipe(jsmn({
    verbose: true,
  })));

gulp.task('test:e2e', done => runSequence(
  'clean',
  'task:e2e_tests:config_check',
  [
    'task:e2e_tests:build',
    'task:e2e_harness:build',
  ],
  'task:e2e_tests:run',
  done
));

gulp.task('task:e2e_tests:config_check', done => {
  fs.exists('./ngsw-config.json', (exists) => {
    if (!exists) {
      throw `ERROR: can't run e2e tests without a ngsw-config.json file`;
    }
    done();
  });
});

gulp.task('task:e2e_tests:run', done => {
  exec('protractor dist/src/test/e2e/spec/protractor.config.js', (err, stdout, stderr) => {
    console.log(stdout);
    console.log(stderr);
    done();
  });
});

const SYSTEM_REGISTER_PREFIX = 'System.registerDynamic("';
const RX_BAD_PREFIX = 'node_modules/rxjs/';

function systemRewriter(inFile: string, outFile: string): void {
  let contents = fs
    .readFileSync(inFile, 'utf8')
    .split('\n')
    .map(line => {
      // Look for System.registerDynamic lines, skipping everything else.
      if (line.substring(0, SYSTEM_REGISTER_PREFIX.length) !== SYSTEM_REGISTER_PREFIX) {
        return line;
      }
      let partial = line.substring(SYSTEM_REGISTER_PREFIX.length);

      // Extract the module name.
      let endQuote = partial.indexOf('"');
      if (endQuote === -1) {
        return line;
      }
      let moduleName = partial.substring(0, endQuote);
      let suffix = partial.substring(endQuote);

      // Rewrite the module name.
      let newModuleName = rewriteModuleName(moduleName);

      // Return the recombined line.
      return SYSTEM_REGISTER_PREFIX + newModuleName + suffix;
    })
    .join('\n');
  fs.writeFileSync(outFile, contents, 'utf8');
}

function rewriteModuleName(module: string): string {
  // Rewrite the bundle to the external module name.
  if (module === 'dist/src/worker-transpiled.js') {
    return '@angular/service-worker/worker';
  }

  // Rewrite node_modules/rxjs/*.js to rxjs/*.
  if (module.substring(0, RX_BAD_PREFIX.length) === RX_BAD_PREFIX) {
    let rxModule = 'rxjs/' + module.substring(RX_BAD_PREFIX.length);
    let dotJs = rxModule.indexOf('.js');
    if (dotJs === -1) {
      return rxModule;
    }
    return rxModule.substring(0, dotJs);
  }
  
  // Ignore other modules.
  return module;
}