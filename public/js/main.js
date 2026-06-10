// ===== Load Site Data from API =====
let siteData = {};

async function loadSiteData() {
  try {
    const res = await fetch('/api/data');
    siteData = await res.json();
    // Check disguise mode
    if (siteData.siteInfo && siteData.siteInfo.disguiseMode) {
      showDisguisePage();
      return;
    }
    renderSite();
  } catch (err) {
    console.error('Failed to load site data:', err);
  }
}

// ===== Disguise Mode =====
function showDisguisePage() {
  // Hide skeleton
  const skeleton = document.getElementById('skeletonLoading');
  if (skeleton) skeleton.style.display = 'none';
  // Hide bottom bar
  const bottomBar = document.querySelector('.bottom-bar');
  if (bottomBar) bottomBar.style.display = 'none';
  // Hide all real content
  document.querySelectorAll('section').forEach(s => s.style.display = 'none');
  document.getElementById('customCursor').style.display = 'none';
  // Show disguise container
  const disguise = document.getElementById('disguisePage');
  if (disguise) disguise.style.display = 'block';
}

function renderSite() {
  renderHero();
  renderInfoBar();
  renderAbout();
  renderExperiences();
  renderWorks();
  renderProcess();
  renderContact();
  renderNav();
}

// ===== Render Hero =====
function renderHero() {
  const hero = siteData.hero;
  if (!hero) return;

  document.getElementById('heroImage').src = hero.image;

  // Setup spotlight + hover image
  const heroSection = document.querySelector('.hero-section');
  const heroImg = document.getElementById('heroImage');
  let isHovering = false;

  // Spotlight follows cursor with smooth lerp
  let targetX = 50, targetY = 50, currentX = 50, currentY = 50;
  function smoothSpotlight() {
    currentX += (targetX - currentX) * 0.1;
    currentY += (targetY - currentY) * 0.1;
    heroSection.style.setProperty('--spotlight-x', currentX + '%');
    heroSection.style.setProperty('--spotlight-y', currentY + '%');
    if (isHovering) requestAnimationFrame(smoothSpotlight);
  }

  heroSection.addEventListener('mousemove', (e) => {
    const rect = heroSection.getBoundingClientRect();
    targetX = ((e.clientX - rect.left) / rect.width) * 100;
    targetY = ((e.clientY - rect.top) / rect.height) * 100;
  });

  heroSection.addEventListener('mouseenter', () => {
    isHovering = true;
    smoothSpotlight();
  });

  heroSection.addEventListener('mouseleave', () => {
    isHovering = false;
  });

  // Hover image switch with fade
  if (hero.hoverImage) {
    const originalSrc = hero.image;
    const hoverSrc = hero.hoverImage;

    // Preload hover image
    const preload = new Image();
    preload.src = hoverSrc;

    heroSection.addEventListener('mouseenter', () => {
      heroImg.style.opacity = '0';
      setTimeout(() => {
        heroImg.src = hoverSrc;
        heroImg.style.opacity = '1';
      }, 300);
    });

    heroSection.addEventListener('mouseleave', () => {
      heroImg.style.opacity = '0';
      setTimeout(() => {
        heroImg.src = originalSrc;
        heroImg.style.opacity = '1';
      }, 300);
    });
  }

  // Top left title (line breaks rendered as <br>)
  document.getElementById('heroTopLeftTitle').innerHTML = (hero.topLeftTitle || '').replace(/\n/g, '<br>');

  // Top right title
  document.getElementById('heroTopRightTitle').innerHTML = (hero.topRightTitle || '').replace(/\n/g, '<br>');

  // Bottom left subtitle + description
  document.getElementById('heroBottomLeftSubtitle').textContent = hero.bottomLeftSubtitle || '';
  document.getElementById('heroBottomLeftDesc').innerHTML = (hero.bottomLeftDesc || '').replace(/\n/g, '<br>');

  // Bottom right description
  document.getElementById('heroBottomRightDesc').innerHTML = (hero.bottomRightDesc || '').replace(/\n/g, '<br>');
}

// ===== Render Info Bar =====
function renderInfoBar() {
  const si = siteData.siteInfo;
  if (!si) return;

  // Wechat
  document.getElementById('infoSocial').innerHTML = `<span>${si.social?.wechat || ''}</span>`;

  // Phone
  const phoneEl = document.getElementById('infoPhone');
  if (phoneEl) phoneEl.innerHTML = `<span>${si.phone || ''}</span>`;

  // Location
  document.getElementById('infoLocation').textContent = si.location || '';

  // Expertise
  const expEl = document.getElementById('infoExpertise');
  expEl.innerHTML = `<span>${(si.expertise || []).join(' / ')}</span>`;
}

// ===== Render About =====
function renderAbout() {
  const about = siteData.about;
  if (!about) return;

  document.getElementById('aboutTitle').textContent = about.title || 'ABOUT';
  document.getElementById('aboutNumber').textContent = about.number || 'S01';
  document.getElementById('aboutText').textContent = about.description || '';
  document.getElementById('aboutImage1').src = about.image1 || '';
  document.getElementById('aboutImage2').src = about.image2 || '';
  document.getElementById('aboutStatLabel1').textContent = about.statLabel1 || 'Works';
  document.getElementById('aboutWorks').textContent = String(about.works || 0).padStart(2, '0');
  document.getElementById('aboutStatLabel2').textContent = about.statLabel2 || 'Years';
  document.getElementById('aboutYears').textContent = String(about.years || 0).padStart(2, '0');

  // Resume button
  const resume = siteData.resume;
  const resumeBtn = document.getElementById('resumeBtn');
  if (resumeBtn && resume && resume.enabled && resume.fileUrl) {
    resumeBtn.href = resume.fileUrl;
    resumeBtn.querySelector('.btn-text').textContent = resume.btnText || '下载简历';
    resumeBtn.style.display = 'inline-flex';
  }
}

// ===== Render Experiences =====
function renderExperiences() {
  const section = siteData.experienceSection;
  if (section) {
    document.getElementById('expSectionTitle').textContent = section.title || '工作经历';
    document.getElementById('expSectionNumber').textContent = section.number || 'S02';
  }

  const exps = siteData.experiences;
  if (!exps) return;

  const container = document.getElementById('experienceList');
  container.innerHTML = exps.map(exp => `
    <div class="experience-item">
      <div class="exp-row">
        <div class="exp-date">${exp.startDate && exp.endDate ? exp.startDate + ' / ' + exp.endDate : ''}</div>
        <div class="exp-divider"></div>
        <div class="exp-role">${exp.role}</div>
        <div class="exp-company">${exp.company}</div>
      </div>
      <div class="exp-row exp-row-desc">
        <div class="exp-date-placeholder"></div>
        <div class="exp-divider"></div>
        <p class="exp-description">${exp.description}</p>
      </div>
    </div>
  `).join('');
}

// ===== Render Works =====
function renderWorks() {
  const works = (siteData.works || []).filter(w => !w.hidden);
  if (!works.length) return;

  const container = document.getElementById('worksGrid');
  container.innerHTML = works.map(w => `
    <a href="/work/${w.id}" class="work-item">
      <div class="work-meta">
        <span class="work-tags">${w.tags}</span>
        <span class="work-year">${w.year}</span>
      </div>
      <div class="work-image">
        ${w.image ? `<img src="${w.image}" alt="${w.name}" onerror="this.style.display='none'">` : ''}
      </div>
      <div class="work-info">
        <h3 class="work-name">${w.name}</h3>
        <span class="work-category">${w.category}</span>
      </div>
    </a>
  `).join('');

  // Re-init work hover
  initWorkHover();
}

// ===== Render Services =====
function renderServices() {
  const svc = siteData.services;
  if (!svc) return;

  document.getElementById('serviceText').textContent = svc.description || '';

  const tagsEl = document.getElementById('serviceTags');
  tagsEl.innerHTML = (svc.specializations || []).map(s => `<span>${s}</span>`).join('');

  const headingsEl = document.getElementById('serviceHeadings');
  headingsEl.innerHTML = (svc.headings || []).map(h => `<h1>${h}</h1>`).join('');
}

// ===== Render Process =====
function renderProcess() {
  const proc = siteData.process;
  if (!proc) return;

  const imagesEl = document.getElementById('processImages');
  if (!imagesEl) return;

  // Render images
  imagesEl.innerHTML = (proc.images || []).map((img, i) => `
    <div class="process-img-wrapper">
      <img src="${img}" alt="Process ${i + 1}">
    </div>
  `).join('');

  // Render steps
  const stepsEl = document.getElementById('processSteps');
  if (!stepsEl) return;
  stepsEl.innerHTML = (proc.steps || []).map((step, i) => `
    <div class="process-step ${i === 0 ? 'active' : ''}" data-step="${step.id}">
      <h4>${step.title}</h4>
    </div>
  `).join('');

  // Set initial description
  if (proc.steps && proc.steps.length > 0) {
    const descEl = document.getElementById('processDesc');
    if (descEl) descEl.textContent = proc.steps[0].description;
  }

  // Re-init process steps interaction
  initProcessSteps();
}

// ===== Render Contact =====
function renderContact() {
  const si = siteData.siteInfo;
  if (!si) return;

  // Email
  const email = si.email || '';
  document.getElementById('contactEmail').textContent = email;

  // Copy button
  const copyBtn = document.getElementById('copyBtn');
  const copyTip = document.getElementById('copyTip');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(email).then(() => {
        copyTip.classList.add('show');
        setTimeout(() => copyTip.classList.remove('show'), 2000);
      });
    });
  }

  // Brand name and subtitle
  document.getElementById('contactBrand').textContent = si.brand || 'Bill.Yu';

  // Wechat
  document.getElementById('contactSocial').innerHTML = `<span>${si.social?.wechat || ''}</span>`;

  // Phone
  document.getElementById('contactPhone').innerHTML = `<span>${si.phone || ''}</span>`;

  // Location
  document.getElementById('contactLocation').innerHTML = `<span>${si.location || ''}</span>`;

  // Expertise
  document.getElementById('contactExpertise').innerHTML = `<span>${(si.expertise || []).join(' / ')}</span>`;
}

// ===== Render Nav Brand =====
function renderNav() {
const si = siteData.siteInfo;
if (!si) return;
document.getElementById('navBrand').textContent = si.copyright || '©2024 GORDIAN';

// Update site title
if (si.siteName) {
  document.title = si.siteName;
}

// Update favicon
if (si.favicon) {
const iconEl = document.getElementById('siteIcon');
if (iconEl) iconEl.href = si.favicon;
}
}

// ===== Live Time Update =====
function updateTime() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
  const timeElements = document.querySelectorAll('.live-time');
  timeElements.forEach(el => {
    el.textContent = timeStr;
  });
}
updateTime();
setInterval(updateTime, 1000);

// ===== About Section Scroll Animation =====
function initAboutAnimation() {
  const aboutSection = document.querySelector('.about-section');
  const aboutText = document.querySelector('.about-text');
  const rotationImages = document.querySelector('.rotation-images');
  const circle1 = document.querySelector('.circle-1');
  const circle2 = document.querySelector('.circle-2');
  const circle1Inner = document.querySelector('.circle-1 .circle-inner');
  const circle2Inner = document.querySelector('.circle-2 .circle-inner');
  const statLeft = document.querySelector('.stat-left');
  const statRight = document.querySelector('.stat-right');

  if (!aboutSection) return;

  // Set initial states
  if (rotationImages) {
    rotationImages.style.opacity = '0';
    rotationImages.style.transform = 'scale(1.5) translateY(-200px)';
  }
  if (aboutText) {
    aboutText.style.opacity = '0';
    aboutText.style.transform = 'translateY(100px)';
  }
  if (statLeft) {
    statLeft.style.opacity = '0';
    statLeft.style.transform = 'translateY(80px)';
  }
  if (statRight) {
    statRight.style.opacity = '0';
    statRight.style.transform = 'translateY(80px)';
  }

  function lerp(start, end, t) {
    return start + (end - start) * t;
  }

  function clamp(val, min, max) {
    return Math.min(Math.max(val, min), max);
  }

  // Easing: cubic ease-out similar to Framer [0.12, 0.23, 0.5, 1]
  function easeOut(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function updateAboutAnimations() {
    const rect = aboutSection.getBoundingClientRect();
    const windowH = window.innerHeight;

    // Progress: 0 when section top enters viewport bottom, 1 when section top reaches viewport top
    const sectionProgress = clamp((windowH - rect.top) / (windowH + rect.height * 0.5), 0, 1);

    // About text: fade in and slide up (triggers early)
    if (aboutText) {
      const textProgress = clamp((sectionProgress - 0) / 0.3, 0, 1);
      const eased = easeOut(textProgress);
      aboutText.style.opacity = eased;
      aboutText.style.transform = `translateY(${lerp(100, 0, eased)}px)`;
    }

    // Rotation images container: scale 1.5→1, translateY -200→0, opacity 0→1
    if (rotationImages) {
      const containerProgress = clamp((sectionProgress - 0.1) / 0.5, 0, 1);
      const eased = easeOut(containerProgress);
      const scale = lerp(1.5, 1, eased);
      const y = lerp(-200, 0, eased);
      rotationImages.style.opacity = eased;
      rotationImages.style.transform = `scale(${scale}) translateY(${y}px)`;
    }

    // Circles rotate around the image center (shared point between circles)
    // Circle 1 (upper): clockwise, Circle 2 (lower): counter-clockwise
    // Full rotation: 0° to 270° by the time section leaves viewport
    const rotationAngle = lerp(0, 270, sectionProgress);
    if (circle1) {
      // Upper circle rotates clockwise
      circle1.style.transform = `rotate(${rotationAngle}deg)`;
    }
    if (circle1Inner) {
      // Counter-rotate inner image to keep it stationary
      circle1Inner.style.transform = `rotate(${-rotationAngle}deg)`;
    }
    if (circle2) {
      // Lower circle rotates clockwise
      circle2.style.transform = `rotate(${rotationAngle}deg)`;
    }
    if (circle2Inner) {
      // Counter-rotate inner image to keep it stationary
      circle2Inner.style.transform = `rotate(${-rotationAngle}deg)`;
    }

    // Stats: slide up and fade in
    if (statLeft) {
      const slProgress = clamp((sectionProgress - 0.5) / 0.3, 0, 1);
      const eased = easeOut(slProgress);
      statLeft.style.opacity = eased;
      statLeft.style.transform = `translateY(${lerp(80, 0, eased)}px)`;
    }
    if (statRight) {
      const srProgress = clamp((sectionProgress - 0.55) / 0.3, 0, 1);
      const eased = easeOut(srProgress);
      statRight.style.opacity = eased;
      statRight.style.transform = `translateY(${lerp(80, 0, eased)}px)`;
    }
  }

  // Run on scroll
  window.addEventListener('scroll', updateAboutAnimations, { passive: true });
  // Run once on init
  updateAboutAnimations();
}

// ===== Scroll Reveal Animation =====
function initScrollReveal() {
  const revealElements = document.querySelectorAll('.section-header, .experience-item, .work-item, .process-section, .contact-header, .contact-brand');

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('revealed');
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateY(0)';
      }
    });
  }, {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
  });

  revealElements.forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(30px)';
    el.style.transition = 'opacity 0.8s ease, transform 0.8s ease';
    observer.observe(el);
  });

  // Giant text slide-in from top (every time)
  const giantText = document.querySelector('.giant-text');
  if (giantText) {
    const giantObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          giantText.classList.add('visible');
        } else {
          giantText.classList.remove('visible');
        }
      });
    }, { threshold: 0.1 });
    giantObserver.observe(giantText);
  }
}

// ===== Smooth Nav Scrolling =====
function initNavigation() {
  const navLinks = document.querySelectorAll('.nav-link, .bottom-bar-left .brand-link');
  navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      const href = link.getAttribute('href');
      if (href.startsWith('#')) {
        e.preventDefault();
        const target = document.querySelector(href);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth' });
        }
      }
    });
  });
}

// ===== Copy Email =====
function initCopyEmail() {
  const emailEl = document.getElementById('contactEmail');
  const copyBtn = document.getElementById('copyBtn');

  if (emailEl) {
    emailEl.addEventListener('click', () => {
      const emailText = siteData.siteInfo?.email || emailEl.textContent;
      navigator.clipboard.writeText(emailText).then(() => {
        copyBtn.classList.add('show');
        setTimeout(() => {
          copyBtn.classList.remove('show');
        }, 2000);
      });
    });
  }
}

// ===== Process Steps Interaction =====
function initProcessSteps() {
  const steps = document.querySelectorAll('.process-step');
  const descEl = document.getElementById('processDesc');
  const timelineLine = document.querySelector('.timeline-line');

  const processSteps = siteData.process?.steps || [];

  steps.forEach(step => {
    step.addEventListener('click', () => {
      steps.forEach(s => s.classList.remove('active'));
      step.classList.add('active');

      const stepNum = parseInt(step.getAttribute('data-step'));
      const stepData = processSteps.find(s => s.id === stepNum);

      if (descEl && stepData) {
        descEl.style.opacity = '0';
        setTimeout(() => {
          descEl.textContent = stepData.description;
          descEl.style.opacity = '1';
        }, 300);
      }

      // Update timeline progress
      if (timelineLine) {
        const progress = (stepNum / processSteps.length) * 100;
        timelineLine.style.setProperty('--progress', progress + '%');
      }
    });
  });
}

// ===== Parallax Effect on Hero =====
function initParallax() {
  // Disable parallax on mobile to prevent scroll jank
  if (window.innerWidth <= 768) return;

  const heroImage = document.querySelector('.hero-image img');
  if (!heroImage) return;

  heroImage.style.willChange = 'transform';
  let ticking = false;

  window.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(() => {
        const scrolled = window.pageYOffset;
        if (scrolled < window.innerHeight) {
          const rate = scrolled * 0.3;
          heroImage.style.transform = `translateY(${rate}px) scale(1.05)`;
        }
        ticking = false;
      });
      ticking = true;
    }
  }, { passive: true });
}

// ===== Work Items Hover Effect (3D Tilt + Custom Cursor) =====
function initWorkHover() {
  const workItems = document.querySelectorAll('.work-item');
  const cursor = document.getElementById('customCursor');
  let cursorX = 0, cursorY = 0;
  let targetX = 0, targetY = 0;
  let animating = false;

  function animateCursor() {
    const ease = 0.045;
    cursorX += (targetX - cursorX) * ease;
    cursorY += (targetY - cursorY) * ease;
    cursor.style.left = cursorX + 'px';
    cursor.style.top = cursorY + 'px';
    if (animating) requestAnimationFrame(animateCursor);
  }

  workItems.forEach(item => {
    item.addEventListener('mousemove', (e) => {
      // 3D tilt
      const rect = item.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const rotateX = ((y - centerY) / centerY) * -2;
      const rotateY = ((x - centerX) / centerX) * 2;
      item.style.transform = `perspective(800px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;

      // Custom cursor follow
      targetX = e.clientX;
      targetY = e.clientY;
    });

    item.addEventListener('mouseenter', (e) => {
      targetX = e.clientX;
      targetY = e.clientY;
      cursorX = e.clientX;
      cursorY = e.clientY;
      cursor.style.left = cursorX + 'px';
      cursor.style.top = cursorY + 'px';
      cursor.classList.add('visible');
      animating = true;
      animateCursor();
    });

    item.addEventListener('mouseleave', () => {
      item.style.transform = '';
      cursor.classList.remove('visible');
      animating = false;
    });
  });
}

// ===== Active nav link on scroll =====
function initActiveNav() {
  const sections = document.querySelectorAll('section[id]');
  const navLinks = document.querySelectorAll('.bottom-bar-right .nav-link');

  function updateActiveNav() {
    let current = '';
    sections.forEach(section => {
      const sectionTop = section.offsetTop;
      if (window.pageYOffset >= sectionTop - 200) {
        current = section.getAttribute('id');
      }
    });

    navLinks.forEach(link => {
      const isActive = link.getAttribute('href') === `#${current}`;
      link.classList.toggle('active', isActive);
    });
  }

  window.addEventListener('scroll', updateActiveNav, { passive: true });
  updateActiveNav();
}

// ===== Hide Skeleton Loading =====
function hideSkeleton() {
  const skeleton = document.getElementById('skeletonLoading');
  if (skeleton) {
    skeleton.style.opacity = '0';
    setTimeout(() => skeleton.remove(), 400);
  }
}

// ===== Initialize =====
document.addEventListener('DOMContentLoaded', () => {
  loadSiteData().then(() => {
    // After data is rendered, init animations
    setTimeout(() => {
      initScrollReveal();
      initAboutAnimation();
    }, 100);
    // Hide skeleton after hero image loads
    const heroImg = document.getElementById('heroImage');
    if (heroImg && heroImg.src) {
      if (heroImg.complete) {
        hideSkeleton();
      } else {
        heroImg.onload = hideSkeleton;
        heroImg.onerror = hideSkeleton;
      }
    } else {
      hideSkeleton();
    }
  });
  initNavigation();
  initCopyEmail();
  initParallax();
  initActiveNav();
  initGiantTextMagnifier();
});

// ===== Giant Text Magnifier Effect =====
function initGiantTextMagnifier() {
  const giantText = document.querySelector('.giant-text');
  if (!giantText) return;

  // Create magnifier element
  const magnifier = document.createElement('div');
  magnifier.className = 'giant-magnifier';
  magnifier.innerHTML = '<div class="giant-magnifier-content"></div>';
  document.body.appendChild(magnifier);

  const magnifierContent = magnifier.querySelector('.giant-magnifier-content');
  const SIZE = 220;
  const SCALE = 1.8;
  let isHovering = false;
  let rafId = null;
  let mouseX = 0, mouseY = 0;

  function updateMagnifier() {
    if (!isHovering) return;
    const rect = giantText.getBoundingClientRect();

    // Position magnifier centered on cursor
    magnifier.style.left = (mouseX - SIZE / 2) + 'px';
    magnifier.style.top = (mouseY - SIZE / 2) + 'px';

    // Calculate offset for the cloned content to align with original
    const offsetX = (mouseX - rect.left) * SCALE - SIZE / 2;
    const offsetY = (mouseY - rect.top) * SCALE - SIZE / 2;

    magnifierContent.style.transform = `translate(${-offsetX}px, ${-offsetY}px) scale(${SCALE})`;
    magnifierContent.style.transformOrigin = '0 0';
    magnifierContent.style.width = rect.width + 'px';
    magnifierContent.style.height = rect.height + 'px';

    rafId = requestAnimationFrame(updateMagnifier);
  }

  giantText.addEventListener('mouseenter', (e) => {
    isHovering = true;
    magnifierContent.textContent = giantText.textContent;
    magnifierContent.style.fontSize = window.getComputedStyle(giantText).fontSize;
    magnifierContent.style.fontWeight = window.getComputedStyle(giantText).fontWeight;
    magnifierContent.style.letterSpacing = window.getComputedStyle(giantText).letterSpacing;
    magnifierContent.style.lineHeight = window.getComputedStyle(giantText).lineHeight;
    magnifierContent.style.fontFamily = window.getComputedStyle(giantText).fontFamily;
    magnifierContent.style.whiteSpace = 'nowrap';
    magnifier.classList.add('active');
    mouseX = e.clientX;
    mouseY = e.clientY;
    rafId = requestAnimationFrame(updateMagnifier);
  });

  giantText.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  });

  giantText.addEventListener('mouseleave', () => {
    isHovering = false;
    magnifier.classList.remove('active');
    if (rafId) cancelAnimationFrame(rafId);
  });
}
