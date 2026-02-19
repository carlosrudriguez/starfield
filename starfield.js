/*
  Starfield.js
  ------------
  Lightweight, dependency-free background starfield effect.

  Usage:
    const sf = new Starfield({ target: document.body, fullPage: true });

  Public API:
    sf.start()
    sf.stop()
    sf.resize()
    sf.destroy()
*/
(function (global) {
  "use strict";

  /*
    Default options.
    All of these can be overridden in `new Starfield({...})`.
  */
  var DEFAULTS = {
    // Element or selector to attach the canvas to.
    // If omitted, defaults to document.body.
    target: null,

    // true: canvas covers the viewport (fixed background mode).
    // false: canvas is positioned inside target element only.
    fullPage: true,

    // Start animation loop immediately on construction.
    autostart: true,

    // Canvas stacking order.
    // Typical pattern: 0 for background behind your content, 10+ for overlay.
    zIndex: -1,

    // Fill color drawn each frame before stars.
    backgroundColor: "#000000",

    // Star stroke color.
    starColor: "#FFFFFF",

    // Number of stars in the simulation.
    starCount: 800,

    // Base speed in depth units per 60fps-equivalent frame.
    speed: 10,

    // Base trail length used to draw streaks.
    trailLength: 10,

    // Device-specific speed tuning.
    mobileSpeedMultiplier: 0.5,
    desktopSpeedMultiplier: 1.1,

    // Device-specific trail tuning.
    mobileTrailMultiplier: 0.65,
    desktopTrailMultiplier: 1,

    // Viewport threshold used by mobile detection.
    mobileBreakpoint: 900,

    // Device pixel ratio cap to limit draw cost on very high-DPR displays.
    // Set <= 0 or non-number to use native DPR.
    dprCap: 2
  };

  // Linear mapping helper used for projection math and line width scaling.
  function map(value, istart, istop, ostart, ostop) {
    return ostart + (ostop - ostart) * ((value - istart) / (istop - istart));
  }

  // Clamp helper for safe stroke width bounds.
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // Resolve `target` option into a real DOM element.
  function resolveTarget(target) {
    if (!target) {
      return document.body;
    }
    if (typeof target === "string") {
      var element = document.querySelector(target);
      if (!element) {
        throw new Error('Starfield: target selector "' + target + '" was not found.');
      }
      return element;
    }
    if (target && target.nodeType === 1) {
      return target;
    }
    throw new Error("Starfield: target must be an Element or selector string.");
  }

  /*
    Starfield class.
    Creates a canvas, initializes stars, wires listeners, and optionally starts animation.
  */
  function Starfield(options) {
    this.options = Object.assign({}, DEFAULTS, options || {});
    this.target = resolveTarget(this.options.target);

    /*
      If caller explicitly set `fullPage`, respect it.
      Otherwise auto-detect: body/html target implies full-page mode.
    */
    if (options && Object.prototype.hasOwnProperty.call(options, "fullPage")) {
      this.fullPage = !!options.fullPage;
    } else {
      this.fullPage = this.target === document.body || this.target === document.documentElement;
    }

    // Rendering surface.
    this.canvas = document.createElement("canvas");
    this.canvas.setAttribute("aria-hidden", "true");
    this.ctx = this.canvas.getContext("2d");
    if (!this.ctx) {
      throw new Error("Starfield: failed to get 2D context.");
    }

    // Star simulation/state.
    this.stars = [];
    this.width = 0;
    this.height = 0;
    this.centerX = 0;
    this.centerY = 0;
    this.maxDepth = 0;
    this.speedMultiplier = this.options.desktopSpeedMultiplier;
    this.trailLength = this.options.trailLength * this.options.desktopTrailMultiplier;

    // Animation loop state.
    this.lastTime = 0;
    this.running = false;
    this.rafId = null;

    // Resize/listener bookkeeping.
    this.resizeObserver = null;
    this.mutatedTargetPosition = false;
    this.originalTargetPosition = "";

    // Bind methods once so add/remove listener uses the same function references.
    this.onResize = this.resize.bind(this);
    this.onAnimate = this.animate.bind(this);

    this.applyCanvasStyles();
    this.mountCanvas();
    this.initStars();
    this.resize();
    this.attachListeners();

    if (this.options.autostart) {
      this.start();
    }
  }

  /*
    Apply all required canvas styles in JS so consumers do not need extra CSS.
    - Full-page mode uses fixed viewport sizing.
    - Container mode pins canvas inside the target element.
  */
  Starfield.prototype.applyCanvasStyles = function () {
    var style = this.canvas.style;
    style.display = "block";
    style.pointerEvents = "none";
    style.zIndex = String(this.options.zIndex);

    if (this.fullPage) {
      style.position = "fixed";
      style.inset = "0";
      style.width = "100vw";
      style.height = "100vh";
      return;
    }

    /*
      In container mode, absolute-position canvas needs a positioned parent.
      If target is `position: static`, temporarily promote it to `relative`.
      On destroy(), we restore the original inline style.
    */
    var computed = global.getComputedStyle(this.target);
    if (computed.position === "static") {
      this.originalTargetPosition = this.target.style.position;
      this.target.style.position = "relative";
      this.mutatedTargetPosition = true;
    }

    style.position = "absolute";
    style.inset = "0";
    style.width = "100%";
    style.height = "100%";
  };

  // Attach canvas to target.
  Starfield.prototype.mountCanvas = function () {
    this.target.appendChild(this.canvas);
  };

  /*
    Listen for environment size changes.
    - Always listen to window resize.
    - In container mode, also observe target element resize if available.
  */
  Starfield.prototype.attachListeners = function () {
    global.addEventListener("resize", this.onResize, { passive: true });
    if (!this.fullPage && global.ResizeObserver) {
      this.resizeObserver = new global.ResizeObserver(this.onResize);
      this.resizeObserver.observe(this.target);
    }
  };

  // Remove event observers/listeners.
  Starfield.prototype.detachListeners = function () {
    global.removeEventListener("resize", this.onResize);
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
  };

  /*
    Mobile detection controls speed/trail multipliers.
    Rule:
    - coarse pointer OR small viewport side < mobileBreakpoint
  */
  Starfield.prototype.isMobileViewport = function () {
    return (
      global.matchMedia("(pointer: coarse)").matches ||
      Math.min(global.innerWidth, global.innerHeight) < this.options.mobileBreakpoint
    );
  };

  // Effective DPR with optional cap to control performance.
  Starfield.prototype.getDpr = function () {
    var dpr = global.devicePixelRatio || 1;
    var cap = this.options.dprCap;
    if (typeof cap === "number" && cap > 0) {
      return Math.min(dpr, cap);
    }
    return dpr;
  };

  // Build initial star pool.
  Starfield.prototype.initStars = function () {
    this.stars.length = 0;
    for (var i = 0; i < this.options.starCount; i += 1) {
      this.stars.push(this.createStar(true));
    }
  };

  // Create one star object.
  Starfield.prototype.createStar = function (initial) {
    var star = { x: 0, y: 0, z: 0, pz: 0 };
    this.resetStar(star, initial);
    return star;
  };

  /*
    Reset a star.
    - x/y: random spread around center.
    - z: random depth on initial fill, maxDepth on recycle.
    - pz: previous depth mirrors z initially.
  */
  Starfield.prototype.resetStar = function (star, initial) {
    var z = initial ? Math.random() * this.maxDepth : this.maxDepth;
    star.x = (Math.random() * this.width - this.width / 2) * 2;
    star.y = (Math.random() * this.height - this.height / 2) * 2;
    star.z = z;
    star.pz = z;
  };

  // 3D -> 2D projection helpers.
  Starfield.prototype.projectX = function (x, z) {
    return map(x / z, 0, 1, 0, this.width / 2) + this.centerX;
  };

  Starfield.prototype.projectY = function (y, z) {
    return map(y / z, 0, 1, 0, this.height / 2) + this.centerY;
  };

  // Screen bounds test.
  Starfield.prototype.isOffscreen = function (x, y) {
    return x < 0 || x > this.width || y < 0 || y > this.height;
  };

  /*
    Physics update for one star.
    Returns true if star should be drawn this frame, false if it was recycled.
  */
  Starfield.prototype.updateStar = function (star, frameScale) {
    // Time-normalized movement keeps speed stable across refresh rates.
    star.z -= this.options.speed * this.speedMultiplier * frameScale;
    if (star.z < 1) {
      this.resetStar(star, false);
      return false;
    }

    // Recycle stars that project outside the visible area.
    var sx = this.projectX(star.x, star.z);
    var sy = this.projectY(star.y, star.z);
    if (this.isOffscreen(sx, sy)) {
      this.resetStar(star, false);
      return false;
    }

    return true;
  };

  /*
    Draw one star as a streak.
    - current point uses current z
    - previous point uses pz + trailLength for a trailing line segment
  */
  Starfield.prototype.drawStar = function (star) {
    var sx = this.projectX(star.x, star.z);
    var sy = this.projectY(star.y, star.z);
    var trailZ = Math.min(this.maxDepth, star.pz + this.trailLength);
    var px = this.projectX(star.x, trailZ);
    var py = this.projectY(star.y, trailZ);

    this.ctx.beginPath();
    this.ctx.strokeStyle = this.options.starColor;
    this.ctx.lineWidth = clamp(map(star.z, 0, this.maxDepth, 3, 0), 0.1, 3);
    this.ctx.moveTo(px, py);
    this.ctx.lineTo(sx, sy);
    this.ctx.stroke();

    // Persist current depth for the next frame's trail origin.
    star.pz = star.z;
  };

  /*
    Recompute canvas metrics, DPR backing size, device multipliers,
    then reseed stars to avoid visual discontinuities after resize.
  */
  Starfield.prototype.resize = function () {
    var rect;
    if (this.fullPage) {
      this.width = global.innerWidth;
      this.height = global.innerHeight;
    } else {
      rect = this.target.getBoundingClientRect();
      this.width = Math.max(1, Math.floor(rect.width));
      this.height = Math.max(1, Math.floor(rect.height));
    }

    this.centerX = this.width / 2;
    this.centerY = this.height / 2;
    this.maxDepth = Math.max(this.width, this.height);

    var mobile = this.isMobileViewport();
    this.speedMultiplier = mobile
      ? this.options.mobileSpeedMultiplier
      : this.options.desktopSpeedMultiplier;
    this.trailLength = this.options.trailLength * (
      mobile ? this.options.mobileTrailMultiplier : this.options.desktopTrailMultiplier
    );

    var dpr = this.getDpr();
    this.canvas.width = Math.floor(this.width * dpr);
    this.canvas.height = Math.floor(this.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    for (var i = 0; i < this.stars.length; i += 1) {
      this.resetStar(this.stars[i], true);
    }
  };

  /*
    Main animation loop.
    `timestamp` comes from requestAnimationFrame.
  */
  Starfield.prototype.animate = function (timestamp) {
    if (!this.running) {
      return;
    }

    if (!this.lastTime) {
      this.lastTime = timestamp;
    }

    // Cap long frame gaps to avoid giant visual jumps after tab inactivity.
    var deltaMs = Math.min(64, timestamp - this.lastTime);
    this.lastTime = timestamp;

    // Normalize movement to a 60fps baseline.
    var frameScale = deltaMs / (1000 / 60);

    // Paint background first.
    this.ctx.fillStyle = this.options.backgroundColor;
    this.ctx.fillRect(0, 0, this.width, this.height);

    // Update/draw each star.
    for (var i = 0; i < this.stars.length; i += 1) {
      var star = this.stars[i];
      if (this.updateStar(star, frameScale)) {
        this.drawStar(star);
      }
    }

    this.rafId = global.requestAnimationFrame(this.onAnimate);
  };

  // Start animation loop.
  Starfield.prototype.start = function () {
    if (this.running) {
      return;
    }
    this.running = true;
    this.lastTime = 0;
    this.rafId = global.requestAnimationFrame(this.onAnimate);
  };

  // Pause animation loop.
  Starfield.prototype.stop = function () {
    if (!this.running) {
      return;
    }
    this.running = false;
    if (this.rafId !== null) {
      global.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  };

  /*
    Fully tear down the instance:
    - stop loop
    - remove listeners
    - remove canvas
    - restore target inline position style if we mutated it
  */
  Starfield.prototype.destroy = function () {
    this.stop();
    this.detachListeners();

    if (this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }

    if (this.mutatedTargetPosition) {
      this.target.style.position = this.originalTargetPosition;
      this.mutatedTargetPosition = false;
    }
  };

  // Public export.
  global.Starfield = Starfield;
})(window);
