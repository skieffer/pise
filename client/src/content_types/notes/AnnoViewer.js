/* ------------------------------------------------------------------------- *
 *  Copyright (c) 2011-2023 Proofscape Contributors                          *
 *                                                                           *
 *  Licensed under the Apache License, Version 2.0 (the "License");          *
 *  you may not use this file except in compliance with the License.         *
 *  You may obtain a copy of the License at                                  *
 *                                                                           *
 *      http://www.apache.org/licenses/LICENSE-2.0                           *
 *                                                                           *
 *  Unless required by applicable law or agreed to in writing, software      *
 *  distributed under the License is distributed on an "AS IS" BASIS,        *
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. *
 *  See the License for the specific language governing permissions and      *
 *  limitations under the License.                                           *
 * ------------------------------------------------------------------------- */

import { BasePageViewer } from "./BasePageViewer";
import { Sidebar } from "./Sidebar";

const dojo = {};
const ise = {};

define([
    "dojo/query",
    "ise/util",
], function(
    query,
    util
) {
    dojo.query = query;
    ise.util = util;
});


export class AnnoViewer extends BasePageViewer {

    /*
     * param nm: The NotesManager.
     * param parent: The DOM element in which page content is to be set.
     * param pane: The ContentPane where parent lives.
     * param uuid: The uuid of the pane where parent lives.
     * param options: {
     *   overviewScale: desired initial scale for overview panel
     * }
     */
    constructor(nm, parent, pane, uuid, options) {
        super(nm, "NOTES");
        options = options || {};

        this.nm = nm;
        this.uuid = uuid;
        this.subscriptionManager = nm.annoSubscriptionManager;

        this.elt = document.createElement('div');
        const sidebarDiv = document.createElement('div');
        this.mainview = document.createElement('div');
        const main = this.mainview;
        main.classList.add('mainview', 'globalZoom');
        main.appendChild(this.elt);
        parent.appendChild(main);
        parent.appendChild(sidebarDiv);

        this.setupBackgroundClickHandler();
        this.attachContextMenu(this.elt, undefined, ['toggleOverview', 'source']);

        const initialScale = options.overviewScale || 20;
        this.sidebar = new Sidebar(
            this, sidebarDiv, this.elt, this.mainview, initialScale
        );

        this.pane = pane;
        this._scrollNode = main;
        this.listeners = {};
        this.on('pageChange', this.updateOverview.bind(this));
    }

    get contentElement() {
        return this.elt;
    }

    get mainContentArea() {
        return this.mainview;
    }

    get scrollNode() {
        return this._scrollNode;
    }

    observeWidgetVisualUpdate(event) {
        this.updateOverview();
    }

    observePageUpdate(loc) {
        this.updateOverview();
    }

    updateOverview() {
        this.sidebar.update();
    }

    showOverviewSidebar(doShow) {
        const grandparent = this.contentElement.parentElement.parentElement;
        if (doShow) {
            this.sidebar.update();
            this.sidebar.centerGlass();
            grandparent.classList.add('showSidebar');
        } else {
            grandparent.classList.remove('showSidebar');
        }
    }

    toggleOverviewSidebar() {
        this.showOverviewSidebar(!this.sidebarIsVisible());
    }

    sidebarIsVisible() {
        const grandparent = this.contentElement.parentElement.parentElement;
        return grandparent.classList.contains('showSidebar');
    }

    getSidebarProperties() {
        return {
            visible: this.sidebarIsVisible(),
            scale: this.sidebar.scale,
        };
    }

    async pageContentsUpdateStep(loc) {
        const currentLoc = this.getCurrentLoc();
        const currentPath = (currentLoc === null) ? null : currentLoc.libpath;
        const currentVers = (currentLoc === null) ? null : currentLoc.version;
        // If page contents were provided directly, just use them.
        if (loc.contents) {
            this.setPageContents(loc.contents.html, loc.contents.data);
        }
        // If not, then retrieve page contents from server if we want
        // a different libpath or version than the current one.
        else if (loc.libpath !== currentPath || loc.version !== currentVers) {
            const contents = await this.loadPageContents(loc);
            this.setPageContents(contents.html, contents.data);
        }
        // Otherwise we don't need to change the page contents.
    }

    /* Given the actual HTML and widget data that define the page we wish to
     * show, set these contents into the page.
     * This means setting the HTML into our page element,
     * requesting MathJax typesetting, and setting up the widgets.
     */
    setPageContents(html, data) {
        const elt = this.contentElement;
        dojo.query(elt).innerHTML(html);
        ise.util.typeset([elt]);
        this.currentPageData = data;
        this.nm.setupWidgets(data, this.elt, this.pane);
    }

    /* Load page data from server.
     *
     * return: promise that resolves with the page contents.
     */
    async loadPageContents({libpath, version}) {
        const data = await this.prepareDataForPageLoad({libpath, version});
        const resp = await this.nm.hub.xhrFor('loadAnnotation', {
            method: "POST",
            query: {libpath: libpath, vers: version},
            form: data,
            handleAs: "json",
        });
        if (resp.err_lvl > 0) {
            throw new Error(resp.err_msg);
        }
        const data_json = resp.data_json;
        return {
            html: resp.html,
            data: JSON.parse(data_json)
        };
    }

    async prepareDataForPageLoad({libpath, version}) {
        const data = {};

        const ssnrMode = this.nm.hub.studyManager.inSsnrMode();
        const studyPagePrefix = 'special.studypage.';
        const studyPageSuffix = '.studyPage';

        if (libpath.startsWith(studyPagePrefix)) {
            data.special = 'studypage';
            if (!ssnrMode) {
                const studypath = libpath.slice(studyPagePrefix.length, -studyPageSuffix.length);
                const resp = await this.nm.hub.xhrFor('lookupGoals', {
                    query: { libpath: studypath, vers: version },
                    handleAs: 'json',
                });
                if (resp.err_lvl > 0) {
                    throw new Error(resp.err_msg);
                }
                const origins = resp.origins;
                const studyData = this.nm.hub.studyManager.buildGoalLookupByList(origins);
                data.studyData = JSON.stringify(studyData)
            }
        }

        return data;
    }

    locIsAtWip(loc) {
        return loc.version === "WIP";
    }

    writeContentDescriptor(serialOnly) {
        const cdo = this.describeCurrentLocation();
        cdo.type = this.nm.hub.contentManager.crType.NOTES;
        cdo.history = this.copyHistory();
        cdo.sidebar = this.getSidebarProperties();
        cdo.ptr = this.ptr;
        return cdo;
    }

    getCurrentLibpath() {
        const loc = this.getCurrentLoc();
        return loc === null ? null : loc.libpath;
    }

    getCurrentLibpathv() {
        const loc = this.getCurrentLoc();
        return loc === null ? null : ise.util.lv(loc.libpath, loc.version);
    }

    setTheme(theme) {
        // Nothing to do.
    }

    setZoom(level) {
        // Nothing to do.
    }

    /* Receive updated page contents.
     *
     * param contents: object with `html` and `data` (widget JSON) properties.
     */
    async receivePublication(contents) {
        // We can use a description of our current location to get the
        // scroll fraction. Then setting the contents directly in the location
        // object will get what we want from our updatePage method.
        const loc = this.describeCurrentLocation();
        loc.contents = contents;
        await super.reloadPage(loc);
    }

}
