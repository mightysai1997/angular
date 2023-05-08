/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {assertDomNode} from '@angular/core/src/util/assert';

describe('assertDomNode', () => {
  it('should not throw for DOM nodes', () => {
    const divFromMainDocument = document.createElement('div');
    expect(() => assertDomNode(divFromMainDocument)).not.toThrow();
  });

  it('should not throw even if the node is from another frame context', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    expect(iframe.contentDocument).toBeDefined();
    const divFromIframe = iframe.contentDocument!.createElement('div');
    document.body.appendChild(divFromIframe);
    iframe.remove();  // iframe removed, but divFromIframe is still in the main document

    expect(() => assertDomNode(divFromIframe)).not.toThrow();
  });

  it('should throw an exception for null', () => {
    expect(() => assertDomNode(null)).toThrow();
  });

  it('should throw an exception for undefined', () => {
    expect(() => assertDomNode(undefined)).toThrow();
  });

  it('should throw an exception for objects that simply define a nodeType field', () => {
    expect(() => assertDomNode({nodeType: true})).toThrow();
  });
});
