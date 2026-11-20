/* Smooth video playback in the photo/video viewer.

   While a video is playing, the decorative ambient glows behind the viewer
   (large 75-80px blurs that pulse continuously) hold still; their pulse resumes
   as soon as playback pauses, ends or the viewer closes. Redrawing those blurs
   and the frosted panels above them on every frame competes with the video
   decoder for the phone's graphics and CPU time, which shows up as dropped
   frames, short stalls and a sluggish screen while a high-resolution video
   plays. Same idea as the existing body.is-scrolling rules; nothing else about
   the viewer changes. */
(() => {
  'use strict';
  const PLAYING = 'detail-video-playing';

  function attach() {
    const video = document.getElementById('detailVideo');
    if (!video || video.__smoothPlayback) return;
    video.__smoothPlayback = true;
    const update = () => {
      const modal = document.getElementById('photoDetailModal');
      const playing = !video.paused && !video.ended && !!modal && modal.style.display === 'flex';
      if (document.body.classList.contains(PLAYING) !== playing) document.body.classList.toggle(PLAYING, playing);
    };
    for (const type of ['play', 'playing', 'pause', 'ended', 'emptied', 'abort', 'error']) {
      video.addEventListener(type, update);
    }
    update();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
  else attach();
})();
