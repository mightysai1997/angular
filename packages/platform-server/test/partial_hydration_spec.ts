/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {DOCUMENT} from '@angular/common';
import {
  APP_ID,
  Component,
  destroyPlatform,
  getPlatform,
  PLATFORM_ID,
  ɵwhenStable as whenStable,
} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {withPartialHydration} from '@angular/platform-browser';

import {getAppContents, prepareEnvironmentAndHydrate, resetTViewsFor} from './dom_utils';
import {getComponentRef, ssr, timeout} from './hydration_utils';

describe('platform-server partial hydration integration', () => {
  let doc: Document;
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;

  beforeAll(async () => {
    globalThis.window = globalThis as unknown as Window & typeof globalThis;
    await import('@angular/core/primitives/event-dispatch/contract_bundle_min.js' as string);
  });

  beforeEach(() => {
    if (getPlatform()) destroyPlatform();
    doc = TestBed.inject(DOCUMENT);
  });

  afterAll(() => {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    destroyPlatform();
  });

  afterEach(() => {
    doc.body.outerHTML = '<body></body>';
    window._ejsas = {};
  });

  describe('annotation', () => {
    it('should annotate inner components with defer block id', async () => {
      @Component({
        standalone: true,
        selector: 'dep-a',
        template: '<button (click)="null">Click A</button>',
      })
      class DepA {}

      @Component({
        standalone: true,
        selector: 'dep-b',
        imports: [DepA],
        template: `
        <dep-a />
        <button (click)="null">Click B</button>
      `,
      })
      class DepB {}

      @Component({
        standalone: true,
        selector: 'app',
        imports: [DepB],
        template: `
        <main (click)="fnA()">
          @defer (on viewport; hydrate on interaction) {
            <div (click)="fnA()">
              Main defer block rendered!
              @if (visible) {
                Defer events work!
              }
              <div id="outer-trigger" (mouseover)="showMessage()"></div>
              @defer (on viewport; hydrate on interaction) {
                <p (click)="fnA()">Nested defer block</p>
                <dep-b />
              } @placeholder {
                <span>Inner block placeholder</span>
              }
            </div>
          } @placeholder {
            <span>Outer block placeholder</span>
          }
        </main>
      `,
      })
      class SimpleComponent {
        items = [1, 2, 3];
        visible = false;
        fnA() {}
        showMessage() {
          this.visible = true;
        }
      }

      const appId = 'custom-app-id';
      const providers = [{provide: APP_ID, useValue: appId}];
      const hydrationFeatures = [withPartialHydration()];

      const html = await ssr(SimpleComponent, {envProviders: providers, hydrationFeatures});
      const ssrContents = getAppContents(html);

      expect(ssrContents).toContain('<main jsaction="click:;">');
      // Buttons inside nested components inherit parent defer block namespace.
      expect(ssrContents).toContain('<button jsaction="click:;" ngb="d1">Click A</button>');
      expect(ssrContents).toContain('<button jsaction="click:;" ngb="d1">Click B</button>');
      expect(ssrContents).toContain('<!--ngh=d0-->');
      expect(ssrContents).toContain('<!--ngh=d1-->');
    }, 100_000);

    describe('basic hydration behavior', () => {
      it('should SSR and hydrate top-level `@defer` blocks', async () => {
        @Component({
          standalone: true,
          selector: 'app',
          template: `
          <main (click)="fnA()">
            @defer (on viewport; hydrate on interaction) {
              <article (click)="fnA()">
                Main defer block rendered!
                @if (visible) {
                  Defer events work!
                }
                <aside id="outer-trigger" (mouseover)="showMessage()"></aside>
                @defer (on viewport; hydrate on interaction) {
                  <p (click)="fnA()">Nested defer block</p>
                } @placeholder {
                  <span>Inner block placeholder</span>
                }
              </article>
            } @placeholder {
              <span>Outer block placeholder</span>
            }
          </main>
        `,
        })
        class SimpleComponent {
          items = [1, 2, 3];
          visible = false;
          fnA() {}
          showMessage() {
            this.visible = true;
          }
        }

        const appId = 'custom-app-id';
        const providers = [{provide: APP_ID, useValue: appId}];
        const hydrationFeatures = [withPartialHydration()];

        const html = await ssr(SimpleComponent, {envProviders: providers, hydrationFeatures});
        const ssrContents = getAppContents(html);

        // Assert that we have `jsaction` annotations and
        // defer blocks are triggered and rendered.

        // <main> uses "eager" `custom-app-id` namespace.
        expect(ssrContents).toContain('<main jsaction="click:;');
        // <div>s inside a defer block have `d0` as a namespace.
        expect(ssrContents).toContain('<article jsaction="click:;keydown:;" ngb="d0');
        expect(ssrContents).toContain('<aside id="outer-trigger" jsaction="mouseover:;" ngb="d0');
        // <p> is inside a nested defer block -> different namespace.
        expect(ssrContents).toContain('<p jsaction="click:;keydown:;" ngb="d1');
        // There is an extra annotation in the TransferState data.
        expect(ssrContents).toContain('"__nghDeferBlocks__":{"d0":null,"d1":"d0"}');
        // Outer defer block is rendered.
        expect(ssrContents).toContain('Main defer block rendered');
        // Inner defer block is rendered as well.
        expect(ssrContents).toContain('Nested defer block');

        // Internal cleanup before we do server->client transition in this test.
        resetTViewsFor(SimpleComponent);

        ////////////////////////////////
        const appRef = await prepareEnvironmentAndHydrate(doc, html, SimpleComponent, {
          envProviders: [...providers, {provide: PLATFORM_ID, useValue: 'browser'}],
          hydrationFeatures,
        });
        const compRef = getComponentRef<SimpleComponent>(appRef);
        appRef.tick();
        await whenStable(appRef);

        const appHostNode = compRef.location.nativeElement;

        // At this point an eager part of an app is hydrated,
        // but defer blocks are still in dehydrated state.

        // <main> no longer has `jsaction` attribute.
        expect(appHostNode.outerHTML).toContain('<main>');

        // Elements from @defer blocks still have `jsaction` annotations,
        // since they were not triggered yet.
        expect(appHostNode.outerHTML).toContain('<article jsaction="click:;keydown:;" ngb="d0');
        expect(appHostNode.outerHTML).toContain(
          '<aside id="outer-trigger" jsaction="mouseover:;" ngb="d0',
        );
        expect(appHostNode.outerHTML).toContain('<p jsaction="click:;keydown:;" ngb="d1');

        // Emit an event inside of a defer block, which should result
        // in triggering the defer block (start loading deps, etc) and
        // subsequent hydration.
        const inner = doc.getElementById('outer-trigger')!;
        const clickEvent2 = new CustomEvent('mouseover', {bubbles: true});
        inner.dispatchEvent(clickEvent2);
        await timeout(1000); // wait for defer blocks to resolve

        appRef.tick();

        // An event was replayed after hydration, which resulted in
        // an `@if` block becoming active and its inner content got
        // rendered/
        expect(appHostNode.outerHTML).toContain('Defer events work');

        // All outer defer block elements no longer have `jsaction` annotations.
        expect(appHostNode.outerHTML).not.toContain('<div jsaction="click:;" ngb="d0');
        expect(appHostNode.outerHTML).not.toContain(
          '<div id="outer-trigger" jsaction="mouseover:;" ngb="d0',
        );

        // Inner defer block was not triggered, thus it retains `jsaction` attributes.
        expect(appHostNode.outerHTML).toContain('<p jsaction="click:;keydown:;" ngb="d1');
      }, 100_000);

      it('should SSR and hydrate nested `@defer` blocks', async () => {
        @Component({
          standalone: true,
          selector: 'app',
          template: `
          <main (click)="fnA()">
            @defer (on viewport; hydrate on interaction) {
              <div (click)="fnA()">
                Main defer block rendered!
                @if (visible) {
                  Defer events work!
                }
                <div id="outer-trigger" (mouseover)="showMessage()"></div>
                @defer (on viewport; hydrate on interaction) {
                  <p (click)="showMessage()">Nested defer block</p>
                } @placeholder {
                  <span>Inner block placeholder</span>
                }
              </div>
            } @placeholder {
              <span>Outer block placeholder</span>
            }
          </main>
        `,
        })
        class SimpleComponent {
          items = [1, 2, 3];
          visible = false;
          fnA() {}
          showMessage() {
            this.visible = true;
          }
        }

        const appId = 'custom-app-id';
        const providers = [{provide: APP_ID, useValue: appId}];
        const hydrationFeatures = [withPartialHydration()];

        const html = await ssr(SimpleComponent, {envProviders: providers, hydrationFeatures});
        const ssrContents = getAppContents(html);

        // Assert that we have `jsaction` annotations and
        // defer blocks are triggered and rendered.

        // <main> uses "eager" `custom-app-id` namespace.
        expect(ssrContents).toContain('<main jsaction="click:;');
        // <div>s inside a defer block have `d0` as a namespace.
        expect(ssrContents).toContain('<div jsaction="click:;keydown:;" ngb="d0"');
        expect(ssrContents).toContain('<div id="outer-trigger" jsaction="mouseover:;" ngb="d0"');
        // <p> is inside a nested defer block -> different namespace.
        expect(ssrContents).toContain('<p jsaction="click:;keydown:;" ngb="d1');
        // There is an extra annotation in the TransferState data.
        expect(ssrContents).toContain('"__nghDeferBlocks__":{"d0":null,"d1":"d0"}');
        // Outer defer block is rendered.
        expect(ssrContents).toContain('Main defer block rendered');
        // Inner defer block is rendered as well.
        expect(ssrContents).toContain('Nested defer block');

        // Internal cleanup before we do server->client transition in this test.
        resetTViewsFor(SimpleComponent);

        ////////////////////////////////

        const appRef = await prepareEnvironmentAndHydrate(doc, html, SimpleComponent, {
          envProviders: [...providers, {provide: PLATFORM_ID, useValue: 'browser'}],
          hydrationFeatures,
        });
        const compRef = getComponentRef<SimpleComponent>(appRef);
        appRef.tick();
        await whenStable(appRef);

        const appHostNode = compRef.location.nativeElement;

        // At this point an eager part of an app is hydrated,
        // but defer blocks are still in dehydrated state.

        // <main> no longer has `jsaction` attribute.
        expect(appHostNode.outerHTML).toContain('<main>');

        // Elements from @defer blocks still have `jsaction` annotations,
        // since they were not triggered yet.
        expect(appHostNode.outerHTML).toContain('<div jsaction="click:;keydown:;" ngb="d0"');
        expect(appHostNode.outerHTML).toContain(
          '<div id="outer-trigger" jsaction="mouseover:;" ngb="d0',
        );
        expect(appHostNode.outerHTML).toContain('<p jsaction="click:;keydown:;" ngb="d1"');

        // Emit an event inside of a defer block, which should result
        // in triggering the defer block (start loading deps, etc) and
        // subsequent hydration.
        const inner = doc.body.querySelector('p')!;
        const clickEvent = new CustomEvent('click', {bubbles: true});
        inner.dispatchEvent(clickEvent);

        await timeout(1000); // wait for defer blocks to resolve

        appRef.tick();

        // An event was replayed after hydration, which resulted in
        // an `@if` block becoming active and its inner content got
        // rendered/
        expect(appHostNode.outerHTML).toContain('Defer events work');

        // Since inner `@defer` block was triggered, all parent blocks
        // were hydrated as well, so all `jsaction` attributes are removed.
        expect(appHostNode.outerHTML).not.toContain('jsaction="');
      }, 100_000);

      it('should SSR and hydrate only defer blocks with hydrate syntax', async () => {
        @Component({
          standalone: true,
          selector: 'app',
          template: `
          <main (click)="fnA()">
            @defer (hydrate on interaction) {
              <div (click)="fnA()">
                Main defer block rendered!
                @if (visible) {
                  Defer events work!
                }
                <div id="outer-trigger" (mouseover)="showMessage()"></div>
                @defer (on interaction) {
                  <p (click)="showMessage()">Nested defer block</p>
                } @placeholder {
                  <span>Inner block placeholder</span>
                }
              </div>
            } @placeholder {
              <span>Outer block placeholder</span>
            }
          </main>
        `,
        })
        class SimpleComponent {
          items = [1, 2, 3];
          visible = false;
          fnA() {}
          showMessage() {
            this.visible = true;
          }
        }

        const appId = 'custom-app-id';
        const providers = [{provide: APP_ID, useValue: appId}];
        const hydrationFeatures = [withPartialHydration()];

        const html = await ssr(SimpleComponent, {envProviders: providers, hydrationFeatures});
        const ssrContents = getAppContents(html);

        // Assert that we have `jsaction` annotations and
        // defer blocks are triggered and rendered.

        // <main> uses "eager" `custom-app-id` namespace.
        expect(ssrContents).toContain('<main jsaction="click:;');
        // <div>s inside a defer block have `d0` as a namespace.
        expect(ssrContents).toContain('<div jsaction="click:;keydown:;" ngb="d0"');
        expect(ssrContents).toContain('<div id="outer-trigger" jsaction="mouseover:;" ngb="d0"');
        // <p> is inside a nested defer block -> different namespace.
        // expect(ssrContents).toContain('<p jsaction="click:;" ngb="d1');
        // There is an extra annotation in the TransferState data.
        expect(ssrContents).toContain('"__nghDeferBlocks__":{"d0":null,"d1":"d0"}');
        // Outer defer block is rendered.
        expect(ssrContents).toContain('Main defer block rendered');
        // Inner defer block should only display placeholder.
        expect(ssrContents).toContain('Inner block placeholder');

        // Internal cleanup before we do server->client transition in this test.
        resetTViewsFor(SimpleComponent);

        ////////////////////////////////

        const appRef = await prepareEnvironmentAndHydrate(doc, html, SimpleComponent, {
          envProviders: [...providers, {provide: PLATFORM_ID, useValue: 'browser'}],
          hydrationFeatures,
        });
        const compRef = getComponentRef<SimpleComponent>(appRef);
        appRef.tick();
        await whenStable(appRef);

        const appHostNode = compRef.location.nativeElement;

        // At this point an eager part of an app is hydrated,
        // but defer blocks are still in dehydrated state.

        // <main> no longer has `jsaction` attribute.
        expect(appHostNode.outerHTML).toContain('<main>');

        // Elements from @defer blocks still have `jsaction` annotations,
        // since they were not triggered yet.
        expect(appHostNode.outerHTML).toContain('<div jsaction="click:;keydown:;" ngb="d0"');
        expect(appHostNode.outerHTML).toContain(
          '<div id="outer-trigger" jsaction="mouseover:;" ngb="d0',
        );
        // expect(appHostNode.outerHTML).toContain('<p jsaction="click:;" ngb="d1"');

        // Emit an event inside of a defer block, which should result
        // in triggering the defer block (start loading deps, etc) and
        // subsequent hydration.
        const inner = doc.getElementById('outer-trigger')!;
        const clickEvent2 = new CustomEvent('mouseover', {bubbles: true});
        inner.dispatchEvent(clickEvent2);
        await timeout(1000); // wait for defer blocks to resolve

        appRef.tick();

        const innerParagraph = doc.body.querySelector('p')!;
        expect(innerParagraph).toBeUndefined();

        // An event was replayed after hydration, which resulted in
        // an `@if` block becoming active and its inner content got
        // rendered/
        expect(appHostNode.outerHTML).toContain('Defer events work');
        expect(appHostNode.outerHTML).toContain('Inner block placeholder');

        // Since inner `@defer` block was triggered, all parent blocks
        // were hydrated as well, so all `jsaction` attributes are removed.
        expect(appHostNode.outerHTML).not.toContain('jsaction="');
      }, 100_000);
    });

    /* TODO: tests to add

      3. transfer state data is correct for parent / child defer blocks
    */

    describe('triggers', () => {
      describe('hydrate on interaction', () => {
        it('click', async () => {
          @Component({
            standalone: true,
            selector: 'app',
            template: `
            <main (click)="fnA()">
              @defer (on viewport; hydrate on interaction) {
                <article>
                  defer block rendered!
                </article>
              } @placeholder {
                <span>Outer block placeholder</span>
              }
            </main>
          `,
          })
          class SimpleComponent {
            fnA() {}
          }

          const appId = 'custom-app-id';
          const providers = [{provide: APP_ID, useValue: appId}];
          const hydrationFeatures = [withPartialHydration()];

          const html = await ssr(SimpleComponent, {envProviders: providers, hydrationFeatures});
          const ssrContents = getAppContents(html);

          // <main> uses "eager" `custom-app-id` namespace.
          expect(ssrContents).toContain('<main jsaction="click:;');
          // <div>s inside a defer block have `d0` as a namespace.
          expect(ssrContents).toContain('<article jsaction="click:;keydown:;"');
          // Outer defer block is rendered.
          expect(ssrContents).toContain('defer block rendered');

          // Internal cleanup before we do server->client transition in this test.
          resetTViewsFor(SimpleComponent);

          ////////////////////////////////
          const appRef = await prepareEnvironmentAndHydrate(doc, html, SimpleComponent, {
            envProviders: [...providers, {provide: PLATFORM_ID, useValue: 'browser'}],
            hydrationFeatures,
          });
          const compRef = getComponentRef<SimpleComponent>(appRef);
          appRef.tick();
          await whenStable(appRef);

          const appHostNode = compRef.location.nativeElement;

          expect(appHostNode.outerHTML).toContain('<article jsaction="click:;keydown:;"');

          // Emit an event inside of a defer block, which should result
          // in triggering the defer block (start loading deps, etc) and
          // subsequent hydration.
          const article = doc.getElementsByTagName('article')![0];
          const clickEvent = new CustomEvent('click', {bubbles: true});
          article.dispatchEvent(clickEvent);
          await timeout(1000); // wait for defer blocks to resolve

          appRef.tick();
          expect(appHostNode.outerHTML).not.toContain('<div jsaction="click:;keydown:;"');
        }, 100_000);

        it('keydown', async () => {
          @Component({
            standalone: true,
            selector: 'app',
            template: `
            <main (click)="fnA()">
              @defer (on viewport; hydrate on interaction) {
                <article>
                  defer block rendered!
                </article>
              } @placeholder {
                <span>Outer block placeholder</span>
              }
            </main>
          `,
          })
          class SimpleComponent {
            fnA() {}
          }

          const appId = 'custom-app-id';
          const providers = [{provide: APP_ID, useValue: appId}];
          const hydrationFeatures = [withPartialHydration()];

          const html = await ssr(SimpleComponent, {envProviders: providers, hydrationFeatures});
          const ssrContents = getAppContents(html);

          // <main> uses "eager" `custom-app-id` namespace.
          expect(ssrContents).toContain('<main jsaction="click:;');
          // <div>s inside a defer block have `d0` as a namespace.
          expect(ssrContents).toContain('<article jsaction="click:;keydown:;"');
          // Outer defer block is rendered.
          expect(ssrContents).toContain('defer block rendered');

          // Internal cleanup before we do server->client transition in this test.
          resetTViewsFor(SimpleComponent);

          ////////////////////////////////
          const appRef = await prepareEnvironmentAndHydrate(doc, html, SimpleComponent, {
            envProviders: [...providers, {provide: PLATFORM_ID, useValue: 'browser'}],
            hydrationFeatures,
          });
          const compRef = getComponentRef<SimpleComponent>(appRef);
          appRef.tick();
          await whenStable(appRef);

          const appHostNode = compRef.location.nativeElement;

          expect(appHostNode.outerHTML).toContain('<article jsaction="click:;keydown:;"');

          // Emit an event inside of a defer block, which should result
          // in triggering the defer block (start loading deps, etc) and
          // subsequent hydration.
          const article = doc.getElementsByTagName('article')![0];
          const keydownEvent = new KeyboardEvent('keydown');
          article.dispatchEvent(keydownEvent);
          await timeout(1000); // wait for defer blocks to resolve

          appRef.tick();

          expect(appHostNode.outerHTML).not.toContain('<div jsaction="click:;keydown:;"');
        }, 100_000);
      });

      describe('hydrate on hover', () => {
        it('mouseenter', async () => {
          @Component({
            standalone: true,
            selector: 'app',
            template: `
            <main (click)="fnA()">
              @defer (hydrate on hover) {
                <article>
                  defer block rendered!
                </article>
              } @placeholder {
                <span>Outer block placeholder</span>
              }
            </main>
          `,
          })
          class SimpleComponent {
            fnA() {}
          }

          const appId = 'custom-app-id';
          const providers = [{provide: APP_ID, useValue: appId}];
          const hydrationFeatures = [withPartialHydration()];

          const html = await ssr(SimpleComponent, {envProviders: providers, hydrationFeatures});
          const ssrContents = getAppContents(html);

          // <main> uses "eager" `custom-app-id` namespace.
          expect(ssrContents).toContain('<main jsaction="click:;');
          // <div>s inside a defer block have `d0` as a namespace.
          expect(ssrContents).toContain('<article jsaction="mouseenter:;focusin:;"');
          // Outer defer block is rendered.
          expect(ssrContents).toContain('defer block rendered');

          // Internal cleanup before we do server->client transition in this test.
          resetTViewsFor(SimpleComponent);

          ////////////////////////////////
          const appRef = await prepareEnvironmentAndHydrate(doc, html, SimpleComponent, {
            envProviders: [...providers, {provide: PLATFORM_ID, useValue: 'browser'}],
            hydrationFeatures,
          });
          const compRef = getComponentRef<SimpleComponent>(appRef);
          appRef.tick();
          await whenStable(appRef);

          const appHostNode = compRef.location.nativeElement;

          expect(appHostNode.outerHTML).toContain('<article jsaction="mouseenter:;focusin:;"');

          // Emit an event inside of a defer block, which should result
          // in triggering the defer block (start loading deps, etc) and
          // subsequent hydration.
          const article = doc.getElementsByTagName('article')![0];
          const hoverEvent = new CustomEvent('mouseenter', {bubbles: true});
          article.dispatchEvent(hoverEvent);
          await timeout(1000); // wait for defer blocks to resolve

          appRef.tick();

          expect(appHostNode.outerHTML).not.toContain('<div jsaction="mouseenter:;focusin:;"');
        }, 100_000);

        it('focusin', async () => {
          @Component({
            standalone: true,
            selector: 'app',
            template: `
            <main (click)="fnA()">
              @defer (hydrate on hover) {
                <article>
                  defer block rendered!
                </article>
              } @placeholder {
                <span>Outer block placeholder</span>
              }
            </main>
          `,
          })
          class SimpleComponent {
            fnA() {}
          }

          const appId = 'custom-app-id';
          const providers = [{provide: APP_ID, useValue: appId}];
          const hydrationFeatures = [withPartialHydration()];

          const html = await ssr(SimpleComponent, {envProviders: providers, hydrationFeatures});
          const ssrContents = getAppContents(html);

          // <main> uses "eager" `custom-app-id` namespace.
          expect(ssrContents).toContain('<main jsaction="click:;');
          // <div>s inside a defer block have `d0` as a namespace.
          expect(ssrContents).toContain('<article jsaction="mouseenter:;focusin:;"');
          // Outer defer block is rendered.
          expect(ssrContents).toContain('defer block rendered');

          // Internal cleanup before we do server->client transition in this test.
          resetTViewsFor(SimpleComponent);

          ////////////////////////////////
          const appRef = await prepareEnvironmentAndHydrate(doc, html, SimpleComponent, {
            envProviders: [...providers, {provide: PLATFORM_ID, useValue: 'browser'}],
            hydrationFeatures,
          });
          const compRef = getComponentRef<SimpleComponent>(appRef);
          appRef.tick();
          await whenStable(appRef);

          const appHostNode = compRef.location.nativeElement;

          expect(appHostNode.outerHTML).toContain('<article jsaction="mouseenter:;focusin:;"');

          // Emit an event inside of a defer block, which should result
          // in triggering the defer block (start loading deps, etc) and
          // subsequent hydration.
          const article = doc.getElementsByTagName('article')![0];
          const focusEvent = new CustomEvent('focusin', {bubbles: true});
          article.dispatchEvent(focusEvent);
          await timeout(1000); // wait for defer blocks to resolve

          appRef.tick();

          expect(appHostNode.outerHTML).not.toContain('<div jsaction="mouseenter:;focusin:;"');
        }, 100_000);
      });

      xit('viewport', async () => {
        @Component({
          standalone: true,
          selector: 'app',
          template: `
          <main (click)="fnA()">
            @defer (hydrate on viewport) {
              <article>
                defer block rendered!
              </article>
            } @placeholder {
              <span>Outer block placeholder</span>
            }
          </main>
        `,
        })
        class SimpleComponent {
          fnA() {}
        }

        const appId = 'custom-app-id';
        const providers = [{provide: APP_ID, useValue: appId}];
        const hydrationFeatures = [withPartialHydration()];

        const html = await ssr(SimpleComponent, {envProviders: providers, hydrationFeatures});
        const ssrContents = getAppContents(html);

        // <main> uses "eager" `custom-app-id` namespace.
        expect(ssrContents).toContain('<main jsaction="click:;');
        // <div>s inside a defer block have `d0` as a namespace.
        expect(ssrContents).toContain('<article jsaction="mouseenter:;focusin:;"');
        // Outer defer block is rendered.
        expect(ssrContents).toContain('defer block rendered');

        // Internal cleanup before we do server->client transition in this test.
        resetTViewsFor(SimpleComponent);

        ////////////////////////////////
        const appRef = await prepareEnvironmentAndHydrate(doc, html, SimpleComponent, {
          envProviders: [...providers, {provide: PLATFORM_ID, useValue: 'browser'}],
          hydrationFeatures,
        });
        const compRef = getComponentRef<SimpleComponent>(appRef);
        appRef.tick();
        await whenStable(appRef);

        const appHostNode = compRef.location.nativeElement;

        expect(appHostNode.outerHTML).toContain('<article jsaction="mouseenter:;focusin:;"');

        // Emit an event inside of a defer block, which should result
        // in triggering the defer block (start loading deps, etc) and
        // subsequent hydration.
        const article = doc.getElementsByTagName('article')![0];
        const hoverEvent = new CustomEvent('mouseenter', {bubbles: true});
        article.dispatchEvent(hoverEvent);
        await timeout(1000); // wait for defer blocks to resolve

        appRef.tick();

        expect(appHostNode.outerHTML).not.toContain('<div jsaction="mouseenter:;focusin:;"');
        // TODO: Update this test to be a proper test
        expect(false).toBe(true);
      }, 100_000);

      xit('immediate', async () => {
        @Component({
          standalone: true,
          selector: 'app',
          template: `
          <main (click)="fnA()">
            @defer (hydrate on viewport) {
              <article>
                defer block rendered!
              </article>
            } @placeholder {
              <span>Outer block placeholder</span>
            }
          </main>
        `,
        })
        class SimpleComponent {
          fnA() {}
        }

        const appId = 'custom-app-id';
        const providers = [{provide: APP_ID, useValue: appId}];
        const hydrationFeatures = [withPartialHydration()];

        const html = await ssr(SimpleComponent, {envProviders: providers, hydrationFeatures});
        const ssrContents = getAppContents(html);

        // <main> uses "eager" `custom-app-id` namespace.
        expect(ssrContents).toContain('<main jsaction="click:;');
        // <div>s inside a defer block have `d0` as a namespace.
        expect(ssrContents).toContain('<article jsaction="mouseenter:;focusin:;"');
        // Outer defer block is rendered.
        expect(ssrContents).toContain('defer block rendered');

        // Internal cleanup before we do server->client transition in this test.
        resetTViewsFor(SimpleComponent);

        ////////////////////////////////
        const appRef = await prepareEnvironmentAndHydrate(doc, html, SimpleComponent, {
          envProviders: [...providers, {provide: PLATFORM_ID, useValue: 'browser'}],
          hydrationFeatures,
        });
        const compRef = getComponentRef<SimpleComponent>(appRef);
        appRef.tick();
        await whenStable(appRef);

        const appHostNode = compRef.location.nativeElement;

        expect(appHostNode.outerHTML).toContain('<article jsaction="mouseenter:;focusin:;"');

        // Emit an event inside of a defer block, which should result
        // in triggering the defer block (start loading deps, etc) and
        // subsequent hydration.
        const article = doc.getElementsByTagName('article')![0];
        const hoverEvent = new CustomEvent('mouseenter', {bubbles: true});
        article.dispatchEvent(hoverEvent);
        await timeout(1000); // wait for defer blocks to resolve

        appRef.tick();

        expect(appHostNode.outerHTML).not.toContain('<div jsaction="mouseenter:;focusin:;"');
        // TODO: Update this test to be a proper test
        expect(false).toBe(true);
      }, 100_000);

      xit('idle', async () => {
        @Component({
          standalone: true,
          selector: 'app',
          template: `
          <main (click)="fnA()">
            @defer (hydrate on viewport) {
              <article>
                defer block rendered!
              </article>
            } @placeholder {
              <span>Outer block placeholder</span>
            }
          </main>
        `,
        })
        class SimpleComponent {
          fnA() {}
        }

        const appId = 'custom-app-id';
        const providers = [{provide: APP_ID, useValue: appId}];
        const hydrationFeatures = [withPartialHydration()];

        const html = await ssr(SimpleComponent, {envProviders: providers, hydrationFeatures});
        const ssrContents = getAppContents(html);

        // <main> uses "eager" `custom-app-id` namespace.
        expect(ssrContents).toContain('<main jsaction="click:;');
        // <div>s inside a defer block have `d0` as a namespace.
        expect(ssrContents).toContain('<article jsaction="mouseenter:;focusin:;"');
        // Outer defer block is rendered.
        expect(ssrContents).toContain('defer block rendered');

        // Internal cleanup before we do server->client transition in this test.
        resetTViewsFor(SimpleComponent);

        ////////////////////////////////
        const appRef = await prepareEnvironmentAndHydrate(doc, html, SimpleComponent, {
          envProviders: [...providers, {provide: PLATFORM_ID, useValue: 'browser'}],
          hydrationFeatures,
        });
        const compRef = getComponentRef<SimpleComponent>(appRef);
        appRef.tick();
        await whenStable(appRef);

        const appHostNode = compRef.location.nativeElement;

        expect(appHostNode.outerHTML).toContain('<article jsaction="mouseenter:;focusin:;"');

        // Emit an event inside of a defer block, which should result
        // in triggering the defer block (start loading deps, etc) and
        // subsequent hydration.
        const article = doc.getElementsByTagName('article')![0];
        const hoverEvent = new CustomEvent('mouseenter', {bubbles: true});
        article.dispatchEvent(hoverEvent);
        await timeout(1000); // wait for defer blocks to resolve

        appRef.tick();

        expect(appHostNode.outerHTML).not.toContain('<div jsaction="mouseenter:;focusin:;"');
        // TODO: Update this test to be a proper test
        expect(false).toBe(true);
      }, 100_000);

      xit('timer', async () => {
        @Component({
          standalone: true,
          selector: 'app',
          template: `
          <main (click)="fnA()">
            @defer (hydrate on viewport) {
              <article>
                defer block rendered!
              </article>
            } @placeholder {
              <span>Outer block placeholder</span>
            }
          </main>
        `,
        })
        class SimpleComponent {
          fnA() {}
        }

        const appId = 'custom-app-id';
        const providers = [{provide: APP_ID, useValue: appId}];
        const hydrationFeatures = [withPartialHydration()];

        const html = await ssr(SimpleComponent, {envProviders: providers, hydrationFeatures});
        const ssrContents = getAppContents(html);

        // <main> uses "eager" `custom-app-id` namespace.
        expect(ssrContents).toContain('<main jsaction="click:;');
        // <div>s inside a defer block have `d0` as a namespace.
        expect(ssrContents).toContain('<article');
        // Outer defer block is rendered.
        expect(ssrContents).toContain('defer block rendered');

        // Internal cleanup before we do server->client transition in this test.
        resetTViewsFor(SimpleComponent);

        ////////////////////////////////
        const appRef = await prepareEnvironmentAndHydrate(doc, html, SimpleComponent, {
          envProviders: [...providers, {provide: PLATFORM_ID, useValue: 'browser'}],
          hydrationFeatures,
        });
        const compRef = getComponentRef<SimpleComponent>(appRef);
        appRef.tick();
        await whenStable(appRef);

        const appHostNode = compRef.location.nativeElement;

        expect(appHostNode.outerHTML).toContain('<article ');

        // Emit an event inside of a defer block, which should result
        // in triggering the defer block (start loading deps, etc) and
        // subsequent hydration.
        const article = doc.getElementsByTagName('article')![0];
        const hoverEvent = new CustomEvent('mouseenter', {bubbles: true});
        article.dispatchEvent(hoverEvent);
        await timeout(1000); // wait for defer blocks to resolve

        appRef.tick();

        expect(appHostNode.outerHTML).not.toContain('<div');
        // TODO: Update this test to be a proper test
        expect(false).toBe(true);
      }, 100_000);
    });
  });
});
