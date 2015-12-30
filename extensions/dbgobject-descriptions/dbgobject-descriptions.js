"use strict";

JsDbg.OnLoad(function () {
    var descriptionTypes = {};
    var descriptionFunctions = [];
    DbgObject._help_AddTypeDescription = {
        description: "Provides a function to produce type-specific formatting of DbgObjects.",
        notes: "The provided function will be used whenever <code>desc()</code> is called on a DbgObject with a matching type.",
        arguments:[
            {name: "module", type:"string", description:"The module of the type."},
            {name: "typeNameOrFn", type:"string/function(string) -> bool", description: "The type name, or a predicate that matches a type name."},
            {name: "description", type:"function(DbgObject) -> string", description: "A function that returns an HTML fragment to describe a given DbgObject."}
        ]
    };
    DbgObject.AddTypeDescription = function(module, typeNameOrFn, description) {
        module = DbgObject.NormalizeModule(module);
        if (typeof(typeNameOrFn) == typeof("")) {
            descriptionTypes[module + "!" + typeNameOrFn] = description;
        } else if (typeof(typeNameOrFn) == typeof(function(){})) {
            descriptionFunctions.push({
                module: module, 
                condition: typeNameOrFn, 
                description: description
            });
        } else {
            throw new Error("You must pass a string or regular expression for the type name.");
        }
    }

    function getTypeDescriptionFunctionIncludingBaseTypes(module, type) {
        function getTypeDescriptionFunction(module, type) {
            var key = module + "!" + type;
            if (key in descriptionTypes) {
                return descriptionTypes[key];
            } else {
                // Check the regex array.
                for (var i = 0; i < descriptionFunctions.length; ++i) {
                    if (descriptionFunctions[i].module == module && descriptionFunctions[i].condition(type)) {
                        return descriptionFunctions[i].description;
                    }
                }
            }

            return null;
        }

        var natural = getTypeDescriptionFunction(module, type);
        if (natural != null) {
            return Promise.as(natural);
        } else if (type == "void") {
            return Promise.as(null);
        }

        return new DbgObject(module, type, 0).baseTypes()
        .then(function (baseTypes) {
            for (var i = 0; i < baseTypes.length; ++i) {
                var desc = getTypeDescriptionFunction(module, baseTypes[i].typeDescription());
                if (desc != null) {
                    return desc;
                }
            }

            return null;
        });
    }
    
    function getTypeDescription(dbgObject) {
        if (dbgObject.isNull()) {
            return Promise.as(null);
        }

        return getTypeDescriptionFunctionIncludingBaseTypes(dbgObject.module, dbgObject.typename)
        .then(function (customDescription) {
            var hasCustomDescription = customDescription != null;
            if (!hasCustomDescription) {
                customDescription = function(x) { 
                    // Default description: first try to get val(), then just provide the pointer with the type.
                    if (x.typename == "bool" || x.bitcount == 1) {
                        return x.val()
                        .then(function (value) {
                            return value == 1 ? "true" : "false";
                        });
                    } else if (x.isScalarType()) {
                        return x.bigval().then(function (bigint) { return bigint.toString(); }); 
                    } else if (x.isPointer()) {
                        return Promise.as(x.deref())
                        .then(function (dereferenced) {
                            return dereferenced.htmlTypeDescription() + " " + dereferenced.ptr();
                        });
                    } else {
                        return x.isEnum()
                        .then(function (isEnum) {
                            if (isEnum) {
                                return x.constant();
                            } else {
                                return Promise.fail();
                            }
                        })
                        .then(null, function () {
                            return x.htmlTypeDescription() + " " + x.ptr();
                        })
                    }
                };
            }

            var description = function(obj) {
                return Promise.as(obj)
                .then(customDescription)
                .then(null, function(err) {
                    if (hasCustomDescription) {
                        // The custom description provider had an error.
                        return obj.typename + "???";
                    } else if (obj.isNull()) {
                        return null;
                    } else {
                        return obj.typename + " " + obj.ptr();
                    }
                }); 
            }

            if (dbgObject.isArray()) {
                var length = dbgObject.arrayLength();
                var elements = [];
                for (var i = 0; i < length; ++i) {
                    elements.push(dbgObject.idx(i));
                }

                return Promise.map(Promise.join(elements), description)
                .then(function(descriptions) {
                    return "[" + descriptions.map(function(d) { return "<div style=\"display:inline-block;\">" + d + "</div>"; }).join(", ") + "]";
                })
            } else {
                return description(dbgObject);
            }
        });
    }

    DbgObject.prototype._help_hasDesc = {
        description: "Indicates if the DbgObject has a type-specific <code>desc()</code> representation.",
        returns: "(A promise to a) bool."
    }
    DbgObject.prototype.hasDesc = function() {
        return getTypeDescriptionFunctionIncludingBaseTypes(this.module, this.typename)
        .then(function (result) {
            return result != null;
        });
    }

    DbgObject.prototype._help_desc = {
        description: "Provides a human-readable description of the object.",
        returns: "A promise to an HTML fragment.",
        notes: function() {
            var html = "<p>Type-specific description generators can be registered with <code>DbgObject.AddTypeDescription</code>.</p>";
            var loadedDescriptionTypes = [];
            for (var key in descriptionTypes) {
                loadedDescriptionTypes.push("<li>" + key + "</li>");
            }
            for (var i = 0; i < descriptionFunctions.length; ++i) {
                loadedDescriptionTypes.push("<li>Predicate: " + descriptionFunctions[i].module + "!(" + descriptionFunctions[i].condition.toString() + ")</li>");
            }
            return html + "Currently registered types with descriptions: <ul>" + loadedDescriptionTypes.join("") + "</ul>";
        }
    }
    DbgObject.prototype.desc = function() {
        return getTypeDescription(this);
    }
});