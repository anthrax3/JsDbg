"use strict";

// type-explorer.js
// UI for interactive exploration of a type and its fields or extensions.

var TypeExplorer = undefined;
JsDbg.OnLoad(function() {
    var allPersistedFields = new PersistedFieldCollection();

    function PersistedFieldCollection() {
        this.persistedFields = [];
        this.store = Catalog.Load("TypeExplorer2");
        this.deserializationPromise = null;
    }

    PersistedFieldCollection.prototype.add = function(pf) {
        this.persistedFields.push(pf);
        return pf.serialize();
    }

    PersistedFieldCollection.prototype.remove = function(pf) {
        this.persistedFields = this.persistedFields.filter(function (x) { return x != pf; });
        var that = this;
        return new Promise(function (oncomplete, onerror) {
            that.store.delete(pf.uniqueId, oncomplete);
        });
    }

    PersistedFieldCollection.prototype.deserialize = function() {
        if (this.deserializationPromise == null) {
            this.deserializationPromise = this._deserialize();
        }
        return this.deserializationPromise;
    }

    PersistedFieldCollection.prototype._deserialize = function() {
        var that = this;
        return new Promise(function (oncomplete, onerror) {
            that.store.all(function (results) {
                if (results) {
                    for (var key in results) {
                        var f = new PersistedField(that);
                        f.deserialize(key, results[key]);
                        that.persistedFields.push(f);
                    }
                }
                oncomplete();
            });
        });
    }

    function PersistedField(collection, module, typeName, name, resultingTypeName, editableFunction) {
        this.uniqueId = "UserField-" + (new Date() - 0) + "-" + Math.round(Math.random() * 1000000)
        this.module = module;
        this.typeName = typeName;
        this.name = name;
        this.resultingTypeName = resultingTypeName;
        this.editableFunction = editableFunction;
        this.collection = collection;
        var that = this;
        this.editableFunctionListener = function() {
            that.serialize();
        }

        if (this.editableFunction) {
            UserEditableFunctions.AddListener(this.editableFunction, this.editableFunctionListener);
        }
    }

    PersistedField.prototype.delete = function() {
        if (this.editableFunction) {
            UserEditableFunctions.RemoveListener(this.editableFunction, this.editableFunctionListener);
        }
        return this.collection.remove(this);
    }

    PersistedField.prototype.serialize = function() {
        var serialized = {
            module: this.module,
            typeName: this.typeName,
            name: this.name,
            resultingTypeName: this.resultingTypeName,
            editableFunction: UserEditableFunctions.Serialize(this.editableFunction)
        };
        var uniqueId = this.uniqueId;
        var store = this.collection.store;
        return new Promise(function (onsuccess, onerror) {
            store.set(uniqueId, serialized, onsuccess);
        });
    }

    PersistedField.prototype.deserialize = function(id, serialized) {
        this.uniqueId = id;
        this.module = serialized.module;
        this.typeName = serialized.typeName;
        this.name = serialized.name;
        this.resultingTypeName = serialized.resultingTypeName;
        this.editableFunction = UserEditableFunctions.Deserialize(serialized.editableFunction);
        this.editableFunction.persistedField = this;
        var that = this;
        UserEditableFunctions.AddListener(this.editableFunction, this.editableFunctionListener);

        if (this.resultingTypeName != null) {
            DbgObject.AddExtendedField(this.module, this.typeName, this.name, this.resultingTypeName, this.editableFunction);
        } else {
            DbgObject.AddTypeDescription(this.module, this.typeName, this.name, false, this.editableFunction);
        }
    }

    PersistedField.prototype.update = function(module, typeName, name, resultingTypeName) {
        var needsUpdate = false;
        if (this.module != module) {
            needsUpdate = true;
            this.module = module;
        }

        if (this.typeName != typeName) {
            needsUpdate = true;
            this.typeName = typeName;
        }

        if (this.name != name) {
            needsUpdate = true;
            this.name = name;
        }

        if (this.resultingTypeName != resultingTypeName) {
            needsUpdate = true;
            this.resultingTypeName = resultingTypeName;
        }

        if (needsUpdate) {
            this.serialize();
        }
    }

    function TypeExplorerAggregateType(module, typename, parentField, controller, rerender) {
        this.parentField = parentField;
        this.controller = controller;
        this.rerender = rerender !== undefined ? rerender : function () { this.parentField.parentType.aggregateType.rerender(); };
        this.searchQuery = "";
        this.backingTypes = [new TypeExplorerSingleType(module, typename, this)];
        this.includeBaseTypes = false;
        this.preparedForRenderingPromise = null;
    }

    TypeExplorerAggregateType.prototype.module = function() {
        return this.backingTypes[0].module;
    }

    TypeExplorerAggregateType.prototype.typename = function () {
        return this.backingTypes[0].typename;
    }

    TypeExplorerAggregateType.prototype.isType = function (module, typename) {
        var primaryType = this.backingTypes[0];
        return (primaryType.module == module && primaryType.typename == typename);
    }

    TypeExplorerAggregateType.prototype.isExpanded = function() {
        return this.backingTypes[0].isExpanded;
    }

    TypeExplorerAggregateType.prototype.prepareForRendering = function() {
        if (this.preparedForRenderingPromise == null) {
            this.preparedForRenderingPromise = this._prepareForRendering();
        }
        return this.preparedForRenderingPromise;
    }

    TypeExplorerAggregateType.prototype._prepareForRendering = function () {
        // Ensure that the base types are loaded and that we've decided whether to include them by default.
        if (this.preparedForRenderingPromise != null) {
            throw new Error("We shouldn't be preparing twice.");
        }

        var that = this;
        return new DbgObject(this.backingTypes[0].module, this.backingTypes[0].typename, 0)
        .baseTypes()
        .then(function (baseTypes) {
            if (!that.hasLoadedBaseTypes) {
                that.hasLoadedBaseTypes = true;
                baseTypes.forEach(function (baseType) {
                    that.backingTypes.push(new TypeExplorerSingleType(baseType.module, baseType.typeDescription(), that));
                })
            }
            return that.backingTypes;
        })
        .then(function (backingTypes) {
            return backingTypes[0].getFields()
        })
        .then(function (primaryTypeFields) {
            that.includeBaseTypes = (primaryTypeFields.length == 0);
            that.isPreparedForRendering = true;
        });
    }

    TypeExplorerAggregateType.prototype.toggleExpansion = function() {
        var that = this;
        this.backingTypes.forEach(function (backingType, i) {
            backingType.isExpanded = !backingType.isExpanded && (i == 0 || that.includeBaseTypes);
        });
    }

    TypeExplorerAggregateType.prototype.hasBaseTypes = function() {
        return this.backingTypes.length > 1;
    }

    TypeExplorerAggregateType.prototype.toggleIncludeBaseTypes = function() {
        this.includeBaseTypes = !this.includeBaseTypes;
        var that = this;
        var isExpanded = this.backingTypes[0].isExpanded;
        this.backingTypes.forEach(function (backingType, i) {
            if (i > 0) {
                backingType.isExpanded = that.includeBaseTypes && isExpanded;
            }
        });
    }

    TypeExplorerAggregateType.prototype.disableCompletely = function() {
        var hadEnabledFields = false;
        this.backingTypes.forEach(function (backingType) {
            hadEnabledFields = backingType.disableCompletely() || hadEnabledFields;
        })
        this.backingTypes = [];
        return hadEnabledFields;
    }

    TypeExplorerAggregateType.prototype.getFieldsToRender = function() {
        console.assert(this.isPreparedForRendering);
        var that = this;
        return Promise.map(this.backingTypes, function (backingType) { return backingType.getFieldsToRender(); })
        .then(this.flattenFieldsFromBackingTypes.bind(this));
    }

    TypeExplorerAggregateType.prototype.getExtendedFieldsToRender = function() {
        console.assert(this.isPreparedForRendering);
        return Promise.map(this.backingTypes, function (backingType) { return backingType.getExtendedFieldsToRender(); })
        .then(this.flattenFieldsFromBackingTypes.bind(this));
    }

    TypeExplorerAggregateType.prototype.getDescriptionsToRender = function() {
        console.assert(this.isPreparedForRendering);
        return Promise.map(this.backingTypes, function (backingType) { return backingType.getDescriptionsToRender(); })
        .then(this.flattenFieldsFromBackingTypes.bind(this));
    }

    TypeExplorerAggregateType.prototype.flattenFieldsFromBackingTypes = function (arrayOfFields) {
        arrayOfFields = arrayOfFields.slice(0);
        arrayOfFields.reverse();
        var result = [];
        arrayOfFields.forEach(function (fields) {
            result = result.concat(fields);
        });
        return result;
    }

    function fuzzyMatch(body, term) {
        if (term.length == 0) {
            return true;
        }

        var firstCharacterIndex = body.indexOf(term[0]);
        if (firstCharacterIndex == -1) {
            return false;
        }

        // Allow slightly transposed fuzzy matches by grabbing the character before the hit.
        var prefix = "";
        if (firstCharacterIndex > 0) {
            prefix = body[firstCharacterIndex - 1];
        }

        return fuzzyMatch(prefix + body.substr(firstCharacterIndex + 1), term.substr(1));
    }

    JsDbg.OnLoad(function() {
        if (typeof Tests !== "undefined") {
            var suite = Tests.CreateTestSuite("TypeExplorer.FuzzyMatch", "Tests for the fuzzy matcher in TypeExplorer.");
            Tests.AddTest(suite, "Basic Matching", function (assert) {
                assert(fuzzyMatch("abc", ""), "[empty string] -> abc");
                assert(fuzzyMatch("abc", "a"), "a -> abc");
                assert(fuzzyMatch("abc", "b"), "b -> abc");
                assert(fuzzyMatch("abc", "c"), "c -> abc");
                assert(fuzzyMatch("abc", "ab"), "ab -> abc");
                assert(fuzzyMatch("abc", "bc"), "bc -> abc");
                assert(fuzzyMatch("abc", "abc"), "abc -> abc");
                assert(!fuzzyMatch("abc", "d"), "d !-> abc");
            });

            Tests.AddTest(suite, "Fuzzy Matching", function (assert) {
                assert(fuzzyMatch("abc", "ac"), "ac -> abc");
                assert(fuzzyMatch("abcde", "ace"), "ace -> abcde");
                assert(!fuzzyMatch("abcde", "afce"), "afce !-> abcde");
                assert(!fuzzyMatch("abcde", "acef"), "acef !-> abcde");
            });

            Tests.AddTest(suite, "Transposed Matching", function (assert) {
                assert(fuzzyMatch("abc", "acb"), "acb -> abc");
                assert(fuzzyMatch("abcde", "acbe"), "acbe -> abcde");
                assert(!fuzzyMatch("abcde", "acbce"), "acbce -> abcde");
                assert(!fuzzyMatch("abcde", "abb"), "abb -> abcde");
                assert(!fuzzyMatch("abcde", "aeb"), "aeb !-> abcde");
            });
        }
    })

    TypeExplorerAggregateType.prototype.isFiltered = function (field) {
        var base = field.name.toLowerCase();
        if (field.resultingTypeName != null) {
            base += " " + field.resultingTypeName.toLowerCase();
        }
        return !fuzzyMatch(base, this.searchQuery.toLowerCase());
    }

    TypeExplorerAggregateType.prototype.setSearchQuery = function(query) {
        this.searchQuery = query;
    }

    // Represents a single type, not including its base types.
    function TypeExplorerSingleType(module, typename, aggregateType) {
        this.aggregateType = aggregateType;
        this.isExpanded = false;
        this.module = module;
        this.typename = typename;
        this.fields = null;
        this.fieldsPromise = null;
        this.extendedFields = [];
        this.descriptions = [];

        var that = this;
        DbgObject.GetExtendedFields(module, typename).forEach(function (extendedField) {
            that.addExtendedField(extendedField.fieldName, extendedField.typeName, extendedField.getter);
        });
        DbgObject.OnExtendedFieldsChanged(module, typename, function (module, typename, fieldName, extendedField, operation, argument) {
            if (operation == "add") {
                that.addExtendedField(fieldName, extendedField.typeName, extendedField.getter);
            } else if (operation == "remove") {
                that.extendedFields = that.extendedFields.filter(function (userField) {
                    if (userField.name == fieldName) {
                        userField.disableCompletely();
                        return false;
                    } else {
                        return true;
                    }
                });
            } else if (operation == "rename") {
                that.extendedFields.forEach(function (userField) {
                    if (userField.name == fieldName) {
                        var wasEnabled = userField.isEnabled;
                        userField.setIsEnabled(false);
                        userField.name = argument;
                        userField.setIsEnabled(wasEnabled);
                    }
                })
            } else if (operation == "typechange") {
                that.extendedFields.forEach(function (userField) {
                    if (userField.name == fieldName) {
                        if (userField.childType != null) {
                            userField.childType.disableCompletely();
                            userField.childType = null;
                            userField.resultingTypeName = argument;
                        }
                    }
                });
            }
            that.aggregateType.rerender();
        });

        DbgObject.GetDescriptions(module, typename).forEach(function (description) {
            if (!description.isPrimary) {
                that.addDescription(description.name, description.getter);
            }
        });

        DbgObject.OnDescriptionsChanged(module, typename, function (module, typename, descriptionName, description, operation, argument) {
            if (operation == "add") {
                if (!description.isPrimary) {
                    that.addDescription(description.name, description.getter);
                }
            } else if (operation == "remove") {
                that.descriptions = that.descriptions.filter(function (descriptionField) {
                    if (descriptionField.name == descriptionName) {
                        descriptionField.disableCompletely();
                        return false;
                    } else {
                        return true;
                    }
                });
            } else if (operation == "rename") {
                that.descriptions.forEach(function (descriptionField) {
                    if (descriptionField.name == descriptionName) {
                        var wasEnabled = descriptionField.isEnabled;
                        descriptionField.setIsEnabled(false);
                        descriptionField.name = argument;
                        descriptionField.setIsEnabled(wasEnabled);
                    }
                })
            }
            that.aggregateType.rerender();
        })
    }

    function renderDbgObject(dbgObject, element, fields) {
        return dbgObject.desc().then(function (desc) {
            var descriptionContainer = document.createElement("div");
            element.appendChild(descriptionContainer);
            descriptionContainer.innerHTML = fields + ":" + desc;
        });
    }

    TypeExplorerSingleType.prototype.addExtendedField = function (fieldName, typeName, getter) {
        var newField = new TypeExplorerField(
            fieldName,
            typeName,
            function getter(dbgObject) {
                return dbgObject.F(newField.name);
            },
            renderDbgObject,
            this,
            getter,
            "extendedFields"
        );
        this.extendedFields.push(newField);

        if (getter.initialType == this.aggregateType) {
            newField.setIsEnabled(true);
        }
    }

    function getDescs(obj) {
        if (obj instanceof Node) {
            return Promise.as(obj);
        } else if (obj instanceof DbgObject) {
            return obj.desc();
        } else if (Array.isArray(obj)) {
            return Promise.map(obj, getDescs)
            .then(function (array) {
                return array.join(", ").toString();
            });
        } else if (typeof(obj) != typeof(undefined)) {
            return Promise.as(obj);
        } else {
            return Promise.as(undefined);
        }
    }

    TypeExplorerSingleType.prototype.addDescription = function (name, getter) {
        var newField = new TypeExplorerField(
            name,
            null,
            function getter(dbgObject) { return dbgObject; },
            function renderer(dbgObject, element, fields) {
                return Promise.as(getter(dbgObject, element))
                .then(getDescs)
                .then(function (desc) {
                    if (desc instanceof Node) {
                        var descriptionContainer = document.createElement("div");
                        element.appendChild(descriptionContainer);
                        descriptionContainer.appendChild(document.createTextNode(fields + ":"));
                        descriptionContainer.appendChild(desc);
                    } else if (typeof(desc) != typeof(undefined)) {
                        var descriptionContainer = document.createElement("div");
                        element.appendChild(descriptionContainer);
                        descriptionContainer.innerHTML = fields + ":" + desc;
                    }
                });
            },
            this,
            getter,
            "descriptions"
        );
        this.descriptions.push(newField);

        if (getter.initialType == this.aggregateType) {
            newField.setIsEnabled(true);
        }
    }

    TypeExplorerSingleType.prototype.getFields = function() {
        if (this.fieldsPromise == null) {
            this.fieldsPromise = this._getFields();
        }
        return this.fieldsPromise;
    }

    TypeExplorerSingleType.prototype._getFields = function() {
        var that = this;
        return new DbgObject(this.module, this.typename, 0)
        .fields(/*includeBaseTypes*/false)
        .then(function (fields) {
            return fields.map(function (field) {
                var dereferencedType = field.value.typeDescription().replace(/\**$/, "");
                return new TypeExplorerField(
                    field.name, 
                    dereferencedType,
                    function getter(dbgObject) {
                        return dbgObject.f(field.name);
                    },
                    renderDbgObject,
                    that,
                    null,
                    "fields"
                );
            })
        })
        .then(function (fields) {
            if (that.fields == null) {
                that.fields = fields;
            }
            return that.fields;
        });
    }

    TypeExplorerSingleType.prototype.considerFieldWhenCollapsed = function (field, shownFields) {
        if (field.isEnabled) {
            shownFields.push(field);
        }
        if (field.childType != null && field.childType != false) {
            field.childType.backingTypes.forEach(function (backingType) {
                if (backingType.fields != null) {
                    backingType.fields.forEach(function (field) {
                        backingType.considerFieldWhenCollapsed(field, shownFields);
                    });
                }

                backingType.extendedFields.forEach(function (field) {
                    backingType.considerFieldWhenCollapsed(field, shownFields);
                });

                backingType.descriptions.forEach(function (field) {
                    backingType.considerFieldWhenCollapsed(field, shownFields);
                })
            });
        }
    }

    TypeExplorerSingleType.prototype.getFieldsToRender = function () {
        return this.getFields().then(this.adjustFieldsForCollapsing.bind(this));
    }

    TypeExplorerSingleType.prototype.getExtendedFieldsToRender = function() {
        return Promise.as(this.extendedFields).then(this.adjustFieldsForCollapsing.bind(this));
    }

    TypeExplorerSingleType.prototype.getDescriptionsToRender = function() {
        return Promise.as(this.descriptions).then(this.adjustFieldsForCollapsing.bind(this));
    }

    TypeExplorerSingleType.prototype.adjustFieldsForCollapsing = function(allFields) {
        if (this.isExpanded) {
            return allFields;
        } else {
            var shownFields = [];
            var that = this;
            allFields.forEach(function (f) {
                that.considerFieldWhenCollapsed(f, shownFields);
            });
            return shownFields;
        }
    }

    TypeExplorerSingleType.prototype.disableCompletely = function() {
        var hadEnabledFields = false;
        if (this.fields != null) {
            this.fields.forEach(function (f) { hadEnabledFields = f.disableCompletely() || hadEnabledFields; });
            this.fields = [];
        }

        if (this.extendedFields != null) {
            this.extendedFields.forEach(function (f) { hadEnabledFields = f.disableCompletely() || hadEnabledFields; });
            this.extendedFields = [];
        }

        if (this.descriptions != null) {
            this.descriptions.forEach(function (f) { hadEnabledFields = f.disableCompletely() || hadEnabledFields; });
            this.descriptions = [];
        }
        return hadEnabledFields;
    }

    function TypeExplorerField(name, resultingTypeName, getter, renderer, parentType, editableFunction, sourceInParentType) {
        this.name = name;
        this.parentType = parentType;
        this.resultingTypeName = resultingTypeName;
        this.childType = null;
        this.childTypePromise = null;
        this.isEnabled = false;
        this.getter = getter;
        this.renderer = renderer;
        this.editableFunction = editableFunction;
        this.fieldRenderer = this.renderField.bind(this);
        this.sourceInParentType = sourceInParentType;
    }

    TypeExplorerField.prototype.renderField = function(dbgObject, element) {
        var names = [];

        var parentFields = [];
        var currentField = this;
        while (currentField != null) {
            parentFields.push(currentField);
            currentField = currentField.parentType.aggregateType.parentField;
        }

        parentFields.reverse();
        var fields = parentFields.map(function (field) { return field.name; }).join(".");
        var getters = parentFields.map(function (field) { return field.getter; });

        var dbgObjectToRender = Promise.as(dbgObject);
        getters.forEach(function (getter) {
            dbgObjectToRender = dbgObjectToRender.then(getter);
        });

        var that = this;
        return dbgObjectToRender
        .then(function (dbgObjectToRender) {
            if (!dbgObjectToRender.isNull()) {
                return that.renderer(dbgObjectToRender, element, fields);
            }
        })
        .then(null, function (ex) {
            var errorContainer = document.createElement("div");
            errorContainer.style.color = "red";
            element.appendChild(errorContainer);
            var errorMsg = ex.stack ? ex.toString() : JSON.stringify(ex);
            errorContainer.innerHTML = "(" + errorMsg + ")";
        });
    }

    TypeExplorerField.prototype.isEditable = function() {
        return this.editableFunction && UserEditableFunctions.IsEditable(this.editableFunction);
    }

    TypeExplorerField.prototype.canBeDeleted = function() {
        return this.editableFunction && this.editableFunction.persistedField;
    }

    TypeExplorerField.prototype.beginEditing = function() {
        if (this.isEditable()) {
            var editor = new TypeExplorerFieldEditor(this);
            var that = this;
            editor.beginEditing(
                this.editableFunction.persistedField ? FieldEditability.EditableExceptHasType : FieldEditability.NotEditable, 
                this.parentType.typename, 
                this.name, 
                this.resultingTypeName,
                this.editableFunction,
                function (typename, name, resultingTypeName, editableFunction) {
                    if (that.editableFunction.persistedField) {
                        if (that.resultingTypeName != null) {
                            DbgObject.UpdateExtendedField(that.parentType.module, that.parentType.typename, that.name, name, resultingTypeName);
                        } else {
                            DbgObject.RenameTypeDescription(that.parentType.module, that.parentType.typename, that.name, name);
                        }
                        that.editableFunction.persistedField.update(that.parentType.module, that.parentType.typename, name, resultingTypeName);
                    }
                }
            );
        }
    }

    TypeExplorerField.prototype.delete = function() {
        if (this.canBeDeleted()) {
            if (this.resultingTypeName) {
                DbgObject.RemoveExtendedField(this.parentType.module, this.parentType.typename, this.name);
            } else {
                DbgObject.RemoveTypeDescription(this.parentType.module, this.parentType.typename, this.name);
            }
            this.editableFunction.persistedField.delete();
        }
    }

    TypeExplorerField.prototype.getChildTypeName = function() {
        return this.resultingTypeName;
    }

    TypeExplorerField.prototype.disableCompletely = function() {
        var hadEnabledFields = this.isEnabled;
        this.setIsEnabled(false);
        if (this.childType instanceof TypeExplorerAggregateType) {
            hadEnabledFields = this.childType.disableCompletely() || hadEnabledFields;
        }
        return hadEnabledFields
    }

    TypeExplorerField.prototype.setIsEnabled = function(isEnabled) {
        if (isEnabled != this.isEnabled) {
            this.isEnabled = isEnabled;
            var rootType = this.parentType.aggregateType;
            while (rootType.parentField != null) {
                rootType = rootType.parentField.parentType.aggregateType;
            }

            rootType.controller._notifyFieldChange(this, isEnabled ? "enabled" : "disabled", this.fieldRenderer, this.editableFunction);
        }
    }

    TypeExplorerField.prototype.getChildType = function() {
        if (this.childTypePromise == null) {
            this.childTypePromise = this._getChildType();
        }
        return this.childTypePromise;
    }

    TypeExplorerField.prototype._getChildType = function() {
        var that = this;
        return Promise.as(this.childType)
        .then(function (childType) {
            if (childType == null && that.resultingTypeName != null) {
                return new DbgObject(that.parentType.module, that.resultingTypeName, 0)
                .isTypeWithFields()
                .then(function (isTypeWithFields) {
                    if (!isTypeWithFields) {
                        that.childType = false;
                        return null;
                    } else {
                        that.childType = new TypeExplorerAggregateType(that.parentType.module, that.resultingTypeName, that, that.parentType.aggregateType.controller);
                        return that.childType;
                    }
                }, function () {
                    that.childType = false;
                    return null;
                });
            } else if (childType === false || that.resultingTypeName == null) {
                // There is no child type (i.e. there are no interesting fields).
                return null;
            } else {
                return childType;
            }
        })
    }

    function TypeExplorerFieldEditor() {
    }

    var FieldEditability = {
        FullyEditable: 0,
        NotEditable: 1,
        EditableExceptHasType: 2
    };

    TypeExplorerFieldEditor.prototype.beginEditing = function(editability, typename, fieldName, resultingTypeName, editableFunction, onSave) {
        // Initialize the modal editor.
        var backdrop = document.createElement("div");
        backdrop.classList.add("field-editor");

        document.body.appendChild(backdrop);

        var editor = document.createElement("div");
        editor.classList.add("modal-editor");
        backdrop.appendChild(editor);

        editor.innerHTML = "<table>\
        <tr><td>Type:</td><td class=\"type\"></td></tr>\
        <tr><td>Name:</td><td><input class=\"name\" type=\"text\"></td></tr>\
        <tr><td>Result Type:</td><td><input class=\"has-result-type\" type=checkbox><input class=\"result-type\" type=\"text\"></td></tr>\
        <tr><td>Documentation:</td><td><div class=\"documentation\"></div></td></tr>\
        </table>\
        <div class=\"description\"></div>\
        <div class=\"code-editor\"></div>\
        <div class=\"buttons\"><button class=\"small-button save\">Save</button><button class=\"small-button cancel\">Cancel</button></div>\
        ";

        var functionEditContext = UserEditableFunctions.Edit(editableFunction, editor.querySelector(".code-editor"));

        var documentation = editor.querySelector(".documentation");
        Help.List()
        .map(Help.Link)
        .forEach(function(e) {
            // Tabbing should skip over the documentation links.
            e.setAttribute("tabindex", -1);
            documentation.appendChild(e);
            documentation.appendChild(document.createTextNode(" "));
        })

        editor.querySelector(".type").textContent = typename;
        var nameInput = editor.querySelector(".name");
        nameInput.value = fieldName;
        var hasResultTypeCheckBox = editor.querySelector(".has-result-type");
        hasResultTypeCheckBox.checked = resultingTypeName != null;
        var resultTypeInput = editor.querySelector(".result-type");
        resultTypeInput.value = resultingTypeName;

        var descriptionText = editor.querySelector(".description");
        var synchronizeHasResultType = function() {
            resultTypeInput.disabled = !hasResultTypeCheckBox.checked;
            if (hasResultTypeCheckBox.checked) {
                descriptionText.textContent = "Return a DbgObject (or a promise to a DbgObject) with type \"" + resultTypeInput.value + "\".";
            } else {
                descriptionText.textContent = "Return a DbgObject, an HTML string, an HTML node, modify \"element\", or return a promise.";
            }

            if (editability == FieldEditability.FullyEditable) {
                if (hasResultTypeCheckBox.checked) {
                    functionEditContext.updateArguments(["dbgObject"]);
                } else {
                    functionEditContext.updateArguments(["dbgObject", "element"]);
                }
            }
        }
        hasResultTypeCheckBox.addEventListener("change", synchronizeHasResultType);
        resultTypeInput.addEventListener("input", synchronizeHasResultType);
        synchronizeHasResultType();

        if (editability == FieldEditability.NotEditable) {
            nameInput.disabled = true;
            hasResultTypeCheckBox.style.display = "none";
            resultTypeInput.disabled = true;
        } else {
            if (editability == FieldEditability.EditableExceptHasType) {
                if (resultingTypeName == null) {
                    hasResultTypeCheckBox.parentNode.parentNode.style.display = "none";
                } else {
                    hasResultTypeCheckBox.style.display = "none";
                }
            }

            if (fieldName == "") {
                nameInput.focus();
            } else {
                editor.querySelector("textarea").focus();
            }
        }

        var handleEscape = function (e) {
            if (e.keyCode == 27) {
                dismiss();
            }
        }

        var dismiss = function() {
            document.body.removeChild(backdrop);
            window.removeEventListener("keydown", handleEscape);
        }

        window.addEventListener("keydown", handleEscape);
        editor.querySelector(".cancel").addEventListener("click", dismiss);

        editor.querySelector(".save").addEventListener("click", function() {
            try {
                onSave(typename, nameInput.value, hasResultTypeCheckBox.checked ? resultTypeInput.value : null, editableFunction);
                functionEditContext.commit();
                dismiss();
            } catch (ex) {
                alert(ex);
            }
        })
    }

    function TypeExplorerController(dbgObject, options) {
        this.container = null;
        this.dbgObject = dbgObject;
        this.options = options;
        var that = this;
        this.rootType = new TypeExplorerAggregateType(dbgObject.module, dbgObject.typeDescription(), null, this, function() { return that._renderType(that.rootType, that.container) });
        this.deserializationPromise = allPersistedFields.deserialize();
    }

    TypeExplorerController.prototype.render = function(container) {
        this.container = container;
        var that = this;
        return this.deserializationPromise
        .then(function () {
            that.container.classList.add("collapsed");
            return that._renderType(that.rootType, that.container);
        });
    }

    TypeExplorerController.prototype.enableField = function(path) {
        var that = this;
        return this.deserializationPromise
        .then(function() {
            return that._enableRemainingPath(that.rootType, path, 0);
        });
    }

    TypeExplorerController.prototype.toggleExpansion = function() {
        this.rootType.toggleExpansion();
        this.container.classList.toggle("collapsed");
        return this._renderType(this.rootType, this.container);
    }

    TypeExplorerController.prototype._computePath = function(field) {
        var path = [];
        this._appendPath(field, path);
        path.reverse();
        return path;
    }

    TypeExplorerController.prototype._appendPath = function (obj, path) {
        if (obj instanceof TypeExplorerField) {
            path.push(obj.name);
            path.push(obj.sourceInParentType);
            return this._appendPath(obj.parentType, path);
        } else if (obj instanceof TypeExplorerSingleType) {
            path.push(obj.typename);
            return this._appendPath(obj.aggregateType, path);
        } else if (obj instanceof TypeExplorerAggregateType) {
            if (obj.parentField != null) {
                return this._appendPath(obj.parentField, path);
            }
        }
    }

    TypeExplorerController.prototype._enableRemainingPath = function (obj, path, currentIndex) {
        var that = this;
        if (currentIndex == path.length) {
            if (obj instanceof TypeExplorerField) {
                obj.setIsEnabled(true);
            }
        } else {
            if (obj instanceof TypeExplorerField) {
                return obj.getChildType()
                .then(function (childType) {
                    if (childType != null) {
                        return that._enableRemainingPath(childType, path, currentIndex)
                    }
                });
            } else if (obj instanceof TypeExplorerSingleType) {
                var collection = path[currentIndex];
                if (collection == "fields") {
                    collection = obj.getFields();
                } else {
                    collection = obj[collection];
                }
                currentIndex++;

                return Promise.as(collection)
                .then(function (collection) {
                    for (var i = 0; i < collection.length; ++i) {
                        if (collection[i].name == path[currentIndex]) {
                            return that._enableRemainingPath(collection[i], path, currentIndex + 1);
                        }
                    }
                })
            } else if (obj instanceof TypeExplorerAggregateType) {
                return obj.prepareForRendering()
                .then(function () {
                    for (var i = 0; i < obj.backingTypes.length; ++i) {
                        if (obj.backingTypes[i].typename == path[currentIndex]) {
                            return that._enableRemainingPath(obj.backingTypes[i], path, currentIndex + 1);
                        }
                    }
                });
            }
        }
    }

    TypeExplorerController.prototype._notifyFieldChange = function(field, changeType, dbgObject, dbgObjectRenderer, editableFunction) {
        if (this.options.onFieldChange) {
            this.options.onFieldChange(this._computePath(field), changeType, dbgObject, dbgObjectRenderer, editableFunction);
        }
    }

    TypeExplorerController.prototype._renderType = function(type, typeContainer) {
        typeContainer.innerHTML = "";
        var that = this;
        return type.prepareForRendering()
        .then(function () {
            var fieldListContainer = document.createElement("div");
            if (type.isExpanded()) {
                var filterTextBox = document.createElement("input");
                filterTextBox.classList.add("small-input");
                filterTextBox.placeholder = "Search...";
                filterTextBox.type = "search";
                filterTextBox.value = type.searchQuery;
                typeContainer.appendChild(filterTextBox);
                filterTextBox.focus();
                var searchTimeout = null;
                filterTextBox.addEventListener("input", function () {
                    if (searchTimeout != null) {
                        clearTimeout(searchTimeout);
                    }
                    searchTimeout = setTimeout(function () {
                        type.setSearchQuery(filterTextBox.value);
                        that._renderFieldList(type, fieldListContainer);
                    }, 100);
                });

                if (type.hasBaseTypes()) {
                    var showBaseTypesControl = document.createElement("button");
                    showBaseTypesControl.classList.add("small-button");
                    showBaseTypesControl.textContent = type.includeBaseTypes ? "Exclude Base Types" : "Include Base Types";
                    typeContainer.appendChild(showBaseTypesControl);
                    showBaseTypesControl.addEventListener("click", function () {
                        type.toggleIncludeBaseTypes();
                        showBaseTypesControl.textContent = type.includeBaseTypes ? "Exclude Base Types" : "Include Base Types";
                        that._renderFieldList(type, fieldListContainer);
                    })
                }

                var newExtensionButton = document.createElement("button");
                newExtensionButton.classList.add("small-button");
                newExtensionButton.textContent = "Extend";
                typeContainer.appendChild(newExtensionButton);
                newExtensionButton.addEventListener("click", function() {
                    var editor = new TypeExplorerFieldEditor();
                    var newFunction = UserEditableFunctions.Create(function () { });
                    newFunction.initialType = type;
                    editor.beginEditing(
                        FieldEditability.FullyEditable, 
                        type.typename(), 
                        "", 
                        null, 
                        newFunction,
                        function onSave(typename, name, resultingTypeName, editableFunction) {
                            editableFunction.persistedField = new PersistedField(allPersistedFields, type.module(), typename, name, resultingTypeName, editableFunction);

                            if (resultingTypeName != null) {
                                DbgObject.AddExtendedField(type.module(), typename, name, resultingTypeName, editableFunction);
                            } else {
                                DbgObject.AddTypeDescription(type.module(), typename, name, /*isPrimary*/false, editableFunction);
                            }

                            allPersistedFields.add(editableFunction.persistedField);
                        }
                    );
                });
            }

            typeContainer.appendChild(fieldListContainer);
            return that._renderFieldList(type, fieldListContainer);
        });
    }

    function findFieldNameCollisions(fields, type) {
        var names = {};
        var collisions = {};

        fields.forEach(function (f) {
            if (f.parentType.aggregateType != type) {
                return;
            }

            if (f.name in names) {
                collisions[f.name] = true;
            } else {
                names[f.name] = true;
            }
        })

        return collisions;
    }

    TypeExplorerController.prototype._renderFieldList = function(type, fieldsContainer) {
        var that = this;

        return Promise.join([type.getFieldsToRender(), type.getExtendedFieldsToRender(), type.getDescriptionsToRender()])
        .then(function (results) {
            var fields = results[0];
            var extendedFields = results[1].concat(results[2]);
            fieldsContainer.innerHTML = "";

            // Find any collisions in the fields.
            var fieldCollisions = findFieldNameCollisions(fields, type);
            var extendedFieldCollisions = findFieldNameCollisions(extendedFields, type);

            return Promise.map(extendedFields, function (extendedField) {
                var fieldContainer = document.createElement("label");
                fieldsContainer.appendChild(fieldContainer);
                return that._renderField(extendedField, type, fieldContainer, extendedFieldCollisions);
            })
            .then(function() {
                if (extendedFields.length > 0 && type.isExpanded()) {
                    var hr = document.createElement("hr");
                    fieldsContainer.appendChild(hr);
                }

                return Promise.map(fields, function (field) {
                    var fieldContainer = document.createElement("label");
                    fieldsContainer.appendChild(fieldContainer);
                    return that._renderField(field, type, fieldContainer, fieldCollisions);
                })
            });
        });
    }

    TypeExplorerController.prototype._renderField = function (field, renderingType, fieldContainer, nameCollisions) {
        var currentType = field.parentType;
        var areAllTypesExpanded = true;
        while (areAllTypesExpanded && currentType != null) {
            var isFiltered = currentType.aggregateType.parentField != null && currentType.aggregateType.parentField.parentType.aggregateType.isFiltered(currentType.aggregateType.parentField);
            areAllTypesExpanded = currentType.isExpanded && !isFiltered;
            currentType = currentType.aggregateType.parentField != null ? currentType.aggregateType.parentField.parentType : null;
        }

        fieldContainer.innerHTML = "";

        if (renderingType == field.parentType.aggregateType && renderingType.isFiltered(field)) {
            fieldContainer.classList.add("filtered");
        } else {
            fieldContainer.classList.remove("filtered");
        }

        var input = document.createElement("input");
        fieldContainer.appendChild(input);
        input.type = "checkbox";
        input.checked = field.isEnabled;
        var that = this;
        input.addEventListener("change", function () {
            field.setIsEnabled(input.checked);
        });
        var fieldNameContainer = document.createElement("span");
        fieldNameContainer.classList.add("field-name");

        var currentField = field;
        var names = [field.name];
        while (currentField.parentType.aggregateType != renderingType) {
            currentField = currentField.parentType.aggregateType.parentField;
            names.push(currentField.name);
        }
        if (currentField.name in nameCollisions) {
            names[names.length - 1] = (currentField.parentType.typename) + "::" + names[names.length - 1];
        }

        fieldNameContainer.textContent = names.reverse().join(".");
        fieldContainer.appendChild(fieldNameContainer);
        
        var fieldType = field.getChildTypeName();
        if (fieldType != null) {
            if (areAllTypesExpanded) {
                var fieldTypeContainer = document.createElement("span");
                fieldTypeContainer.classList.add("field-type");
                fieldTypeContainer.textContent = fieldType;
                fieldContainer.appendChild(fieldTypeContainer);
            }
            fieldContainer.title = fieldType + " " + field.name;
        } else {
            fieldContainer.title = field.name;
        }

        if (field.isEditable()) {
            var editButton = document.createElement("button");
            fieldContainer.appendChild(editButton);
            editButton.classList.add("small-button");
            editButton.textContent = "Edit";
            editButton.addEventListener("click", function() { field.beginEditing(); });
        }

        if (field.canBeDeleted()) {
            var deleteButton = document.createElement("button");
            fieldContainer.appendChild(deleteButton);
            deleteButton.classList.add("small-button");
            deleteButton.textContent = "Delete";
            deleteButton.addEventListener("click", function() { field.delete(); });
        }

        return field.getChildType()
        .then(function (childType) {
            if (childType == null || renderingType.isFiltered(field) || !areAllTypesExpanded) {
                return;
            }

            var subFieldsContainer = document.createElement("div");
            subFieldsContainer.classList.add("fields-container");
            if (!childType.isExpanded()) {
                subFieldsContainer.classList.add("collapsed");
            } else {
                subFieldsContainer.classList.remove("collapsed");
            }
            return that._renderType(childType, subFieldsContainer)
            .then(function () {
                fieldContainer.parentNode.insertBefore(subFieldsContainer, fieldContainer.nextSibling);
                fieldTypeContainer.addEventListener("click", function (e) {
                    e.preventDefault();
                    childType.toggleExpansion();
                    subFieldsContainer.classList.toggle("collapsed");
                    that._renderType(childType, subFieldsContainer);
                });
            });
        });
    }

    function create(dbgObject, options) {
        return new TypeExplorerController(dbgObject, options);
    }

    TypeExplorer = {
        Create: create
    };
});