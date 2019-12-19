import { mat4, vec3, vec4 } from 'gl-matrix';
import { gltfLight } from './light.js';
import { gltfTextureInfo } from './texture.js';
import { ShaderCache } from './shader_cache.js';
import { WebGl } from './webgl.js';
import { ToneMaps, DebugOutput, Environments } from './rendering_parameters.js';
import { ImageMimeType } from './image.js';
import { SimpleTriangleBVH } from './bvh.js';
import texturesShader from './shaders/textures.glsl';
import tonemappingShader from './shaders/tonemapping.glsl';
import shaderFunctions from './shaders/functions.glsl';
import pathtracingVertexShader from './shaders/pt.vert';
import pathtracingFragmentShader from './shaders/pt.frag';
import displayVertexShader from './shaders/fs.vert';
import displayFragmentShader from './shaders/fs.frag';
import materialShader from './shaders/material.glsl';
import { floor } from 'gl-matrix/src/gl-matrix/vec2';


function initAndPrintGLInfo(gl)
{
    logI("gl.VENDOR = " + gl.getParameter(gl.VENDOR));
    logI("gl.RENDERER = " + gl.getParameter(gl.RENDERER));
    logI("gl.VERSION = " + gl.getParameter(gl.VERSION));
    logI("gl.MAX_TEXTURE_SIZE = " + gl.getParameter(gl.MAX_TEXTURE_SIZE));
    logI("gl.MAX_3D_TEXTURE_SIZE = " + gl.getParameter(gl.MAX_3D_TEXTURE_SIZE));
    logI("gl.MAX_TEXTURE_IMAGE_UNITS = " + gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS));
    logI("gl.GL_MAX_ARRAY_TEXTURE_LAYERS = " + gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS));

    console.log(gl.getSupportedExtensions());

    let maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

    // without index support this is the max number of triangles
    console.log("Maximum number of triangles allowed: " + ((maxTextureSize * maxTextureSize) / 3 | 0));
}

function fromThetaPhi(out, theta, phi)
{
    vec3.set(out, Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta));
}


function helper_PrintTriangleData(triData, vtxStride)
{
    let numTris = triData.length / (3 * vtxStride) | 0;
    for (let i = 0; i < numTris; i++)
    {
        let i0 = i * (3 * vtxStride);
        let i1 = i * (3 * vtxStride) + vtxStride;
        let i2 = i * (3 * vtxStride) + vtxStride + vtxStride;
        console.log("(" + triData[i0 + 0] + "," + triData[i0 + 1] + "," + triData[i0 + 2] + ") " +
            "(" + triData[i1 + 0] + "," + triData[i1 + 1] + "," + triData[i1 + 2] + ") " +
            "(" + triData[i2 + 0] + "," + triData[i2 + 1] + "," + triData[i2 + 2] + ") ");
    }
}

function createDataTextureRGBA(gl, data, internal_format, format, type)
{
    let maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    let numRGBAblocks = (data.length / 4) | 0;
    let sX = Math.min(numRGBAblocks, maxTextureSize);
    let sY = Math.max(1, ((numRGBAblocks + maxTextureSize - 1) / maxTextureSize) | 0);

    console.log("sX = " + sX + "; sY = " + sY);

    let tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal_format, sX, sY, 0, format, type, null);

    if (sY > 1)
    {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, sX, sY - 1, format, type, data, 0);
    }

    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, sY - 1, numRGBAblocks - sX * (sY - 1), 1, format, type, data, sX * (sY - 1) * 4);

    return tex;
}

function logI(txt)
{
    console.log(txt);
}

function logE(e, txt)
{
    console.log("ERROR: (" + e + "): " + txt);
}

function dataBuffersFromGLTF(gl, gltf, sceneScaleFactor, dataBuffers, position_stride = 4)
{
    let position_buffer = [];
    let normal_buffer = [];
    let uv_buffer = [];

    function parseHierarchy()
    {
        function applyTransform(gltf, node)
        {
        	//node.initGl();
            //mat4.multiply(node.worldTransform, node.getLocalTransform(), parentTransform);
            //mat4.invert(node.inverseWorldTransform, node.worldTransform);
            //mat4.transpose(node.normalMatrix, node.inverseWorldTransform);

            if (node.mesh !== undefined)
            {
                for (const primitive of gltf.meshes[node.mesh].primitives)
                {
                    const positionsAccessor = gltf.accessors[primitive.attributes.POSITION];
                    const positions = positionsAccessor.getTypedView(gltf);

                    let normals = undefined;
                    if("NORMAL" in primitive.attributes)
                        normals = gltf.accessors[primitive.attributes.NORMAL].getTypedView(gltf);
                    let tangents = undefined;
                    if("TANGENT" in primitive.attributes)
                        tangents = gltf.accessors[primitive.attributes.TANGENT].getTypedView(gltf);
                    let uv_0 = undefined;
                    if("TEXCOORD_0" in primitive.attributes)
                        uv_0 = gltf.accessors[primitive.attributes.TEXCOORD_0].getTypedView(gltf);
                    let uv_1 = undefined;
                    if("TEXCOORD_1" in primitive.attributes)
                        uv_1 = gltf.accessors[primitive.attributes.TEXCOORD_1].getTypedView(gltf);

                    if (primitive.indices !== undefined)
                    {
                        const indicesAccessor = gltf.accessors[primitive.indices];
                        const indices = indicesAccessor.getTypedView(gltf);

                        for (let i = 0; i < indices.length; i++)
                        {
                            const idx = indices[i];
                            let pos = vec4.create();
                            pos[0] = positions[idx * 3];
                            pos[1] = positions[idx * 3 + 1];
                            pos[2] = positions[idx * 3 + 2];
                            pos[3] = 0.0;

                            vec4.transformMat4(pos, pos, node.worldTransform);
                            position_buffer.push(pos[0]);
                            position_buffer.push(pos[1]);
                            position_buffer.push(pos[2]);
                            position_buffer.push(primitive.material);

                            if(normals !== undefined) {
                                let n = vec4.create();
                                n[0] = normals[idx * 3];
                                n[1] = normals[idx * 3 + 1];
                                n[2] = normals[idx * 3 + 2];
                                n[3] = 1.0;

                                vec4.transformMat4(n, n, node.normalMatrix);
                                normal_buffer.push(n[0]);
                                normal_buffer.push(n[1]);
                                normal_buffer.push(n[2]);
                                normal_buffer.push(1.0);

                            }
                            if(uv_0 !== undefined) {
                                uv_buffer.push( uv_0[idx * 2]);
                                uv_buffer.push( uv_0[idx * 2+1]);

                                if(uv_1 !== undefined) {
                                    uv_buffer.push( uv_1[idx * 2]);
                                    uv_buffer.push( uv_1[idx * 2+1]);
                                } else {
                                    uv_buffer.push(0.0);
                                    uv_buffer.push(0.0);
                                }
                            } else {
                                uv_buffer.push(.0, .0, .0, .0);
                            }
                        }
                    }
                    else
                    {
                        for (let i = 0; i < positions.length / 3; i++)
                        {
                            let pos = vec4.create();
                            pos[0] = positions[i * 3];
                            pos[1] = positions[i * 3+1];
                            pos[2] = positions[i * 3+2];
                            pos[3] = 0.0;

                            vec4.transformMat4(pos, pos, node.worldTransform);
                            position_buffer.push(pos[0]);
                            position_buffer.push(pos[1]);
                            position_buffer.push(pos[2]);
                            position_buffer.push(primitive.material);

                            if(normals !== undefined) {
                                let n = vec4.create();
                                n[0] = normals[i * 3];
                                n[1] = normals[i * 3 + 1];
                                n[2] = normals[i * 3 + 2];
                                n[3] = 1.0;

                                vec4.transformMat4(n, n, node.normalMatrix);
                                normal_buffer.push(n[0]);
                                normal_buffer.push(n[1]);
                                normal_buffer.push(n[2]);
                                normal_buffer.push(0.0);

                            }
                            if(uv_0 !== undefined) {
                                uv_buffer.push( uv_0[i * 2]);
                                uv_buffer.push( uv_0[i * 2+1]);

                                if(uv_1 !== undefined) {
                                    uv_buffer.push( uv_1[i * 2]);
                                    uv_buffer.push( uv_1[i * 2+1]);
                                } else {
                                    uv_buffer.push(0.0);
                                    uv_buffer.push(0.0);
                                }
                            } else {
                                uv_buffer.push(.0, .0, .0, .0);
                            }
                        }
                    }
                }
            }

            for (const child of node.children)
            {
                applyTransform(gltf, gltf.nodes[child], node.worldTransform);
            }
        }

        for (const node of gltf.scenes[gltf.scene].nodes)
        {
            let root_node = gltf.nodes[node];
            //root_node.initGl();
            //let root_transform = root_node.getLocalTransform();
            //mat4.scale(root_transform, root_transform, vec3.fromValues(sceneScaleFactor, sceneScaleFactor, sceneScaleFactor));
            applyTransform(gltf, root_node);
        }
    }

    parseHierarchy();

    let material_buffer = [];
    let material_texture_info_buffer = [];
    let tex_arrays = [];
    let tex_array_dict = {};
    let tex_res_dict = {};

    function parseTexture(gltfTex) {
        let tex = gltf.textures[gltfTex.index];
        let img = gltf.images[tex.source].image;

        let mat_tex_info = [-1, -1, -1, -1];

        let res = [img.width, img.height];
        if(res in tex_array_dict) {
            let tex_array_idx = tex_array_dict[res];
            tex_arrays[tex_array_idx].push(gltfTex.index);
            mat_tex_info[0] = tex_array_idx;
            mat_tex_info[1] = tex_arrays[tex_array_idx].length - 1;
        } else {
            tex_array_dict[res] = tex_arrays.length;
            tex_res_dict[res] = res;
            let tex_array = [gltfTex.index];
            tex_arrays.push(tex_array);
            mat_tex_info[0] = tex_arrays.length - 1;
            mat_tex_info[1] = 0;
        }

        mat_tex_info[2] = gltfTex.texCoord;
        material_texture_info_buffer = material_texture_info_buffer.concat(mat_tex_info);
    };

    for(const mat of gltf.materials) {
        const base_color = mat.properties.get("u_BaseColorFactor");
        material_buffer.push(base_color[0], base_color[1], base_color[2], base_color[3]);

        if (mat.baseColorTexture !== undefined) {
            parseTexture(mat.baseColorTexture);
        } else {
            material_texture_info_buffer.push(-1, -1, -1, -1);
        }

        const metallic_factor = mat.properties.get("u_MetallicFactor");
        const roughness_factor = mat.properties.get("u_RoughnessFactor");
        material_buffer.push(metallic_factor, roughness_factor);

        if (mat.metallicRoughnessTexture !== undefined) {
            parseTexture(mat.metallicRoughnessTexture);
        } else {
            material_texture_info_buffer.push(-1, -1, -1, -1);
        }

        if (mat.normalTexture !== undefined) {
            parseTexture(mat.normalTexture);
            material_buffer.push(mat.normalTexture.scale);
        } else {
            material_texture_info_buffer.push(-1, -1, -1, -1);
            material_buffer.push(1.0); // normalScale
        }

        if (mat.emissiveTexture !== undefined) {
            parseTexture(mat.emissiveTexture);
            material_buffer.push(mat.emissiveFactor);
        } else {
            material_texture_info_buffer.push(-1, -1, -1, -1);
            material_buffer.push(0.0); // emissiveFactor
        }

        material_buffer.push(1.0, 1.0, 1.0, 1.0); // specularTint, specular
        material_texture_info_buffer.push(-1, -1, -1, -1);
    }

    console.assert(material_buffer.length % 12 === 0, "Size of material buffer has to be a multiple of 12 elements.");

    let tex_array_glids = new Array(tex_arrays.length);
    for(let k of Object.keys(tex_array_dict)) {
        let res = tex_res_dict[k];
        let tex_array_id = tex_array_dict[k];
        let tex_id  = gl.createTexture();
        let width = res[0];
        let height = res[1];
        let num_textures = tex_arrays[tex_array_id].length;
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex_id);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA, width, height, num_textures, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        tex_array_glids[tex_array_id] = tex_id;

        for(let i=0; i < tex_arrays[tex_array_id].length; i++) {
            let tex_info =  gltf.textures[tex_arrays[tex_array_id][i]];
            let img = gltf.images[tex_info.source].image;
            gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, img.width, img.height, 1, gl.RGBA, gl.UNSIGNED_BYTE, img);
        }
    }

    dataBuffers.position_buffer = position_buffer;
    dataBuffers.normal_buffer = normal_buffer;
    dataBuffers.uv_buffer = uv_buffer;
    dataBuffers.material_buffer = material_buffer;
    dataBuffers.material_texture_info_buffer = material_texture_info_buffer;
    dataBuffers.tex_arrays_glids = tex_array_glids;
}


function GLSLRaytracer(webgl, camera, canvas)
{
    let me = this;
    let gl = webgl.context;
    this.gl = webgl.context;

    initAndPrintGLInfo(gl);

    this.dataBuffers = {
        "position_buffer": undefined,
        "material_buffer": undefined,
        "material_texture_info_buffer": undefined,
        "normal_buffer": undefined,
        "uv_buffer": undefined,
        "tex_arrays_glids": undefined
    };

    this.gltf = undefined;
    this.envMapTexture = undefined;

    this.prepareData = function prepareData(gltf, sceneScaleFactor)
    {
        dataBuffersFromGLTF(me.gl, gltf, sceneScaleFactor, me.dataBuffers);
        let position_stride = 4;
        me.numTriangles = me.dataBuffers.position_buffer.length / (position_stride*3);
        me.triBVH = new SimpleTriangleBVH(position_stride);
        me.triBVH.build(me.dataBuffers.position_buffer);
        console.log("NumTriangles = " + me.numTriangles);

        // now we need to reorder the tri data based on the bvh indices created during construction
        //!!TOOPT: do this in place
        let origPositionData = me.dataBuffers.position_buffer;
        let origNormalData = me.dataBuffers.normal_buffer;
        let origUVData = me.dataBuffers.uv_buffer;

        // reorder triangles based on bvh index array
        let _triData = new Float32Array(origPositionData.length);
        let _normalData = new Float32Array(origNormalData.length);
        let _uvData = new Float32Array(origUVData.length);
        for (let i = 0; i < me.numTriangles; i++)
        {
            let srcIdx = me.triBVH.m_pTriIndices[i];
            for (let j = 0; j < (3 * position_stride); j++)
            {
                _triData[i * (3 * position_stride) + j] = origPositionData[srcIdx * (3 * position_stride) + j];
                _normalData[i * (3 * position_stride) + j] = origNormalData[srcIdx * (3 * position_stride) + j];
                _uvData[i * (3 * position_stride) + j] = origUVData[srcIdx * (3 * position_stride) + j];
            }
        }

        let flatBVHdata = me.triBVH.createAndCopyToFlattenedArray_StandardFormat();

        if (me.bvhTexture) gl.deleteTexture(me.bvhTexture);
        if (me.triangleTexture) gl.deleteTexture(me.triangleTexture);
        if (me.normalTexture) gl.deleteTexture(me.normalTexture);
        if (me.uvTexture) gl.deleteTexture(me.uvTexture);
        if (me.materialTexture) gl.deleteTexture(me.materialTexture);
        if (me.materialInfoTexture) gl.deleteTexture(me.materialInfoTexture);

        let matTexInfoBuffer = new Int8Array(me.dataBuffers.material_texture_info_buffer);

        me.bvhTexture = createDataTextureRGBA(gl, flatBVHdata, gl.RGBA32F, gl.RGBA, gl.FLOAT);
        me.triangleTexture = createDataTextureRGBA(gl, _triData, gl.RGBA32F, gl.RGBA, gl.FLOAT);
        me.normalTexture = createDataTextureRGBA(gl, _normalData, gl.RGBA32F, gl.RGBA, gl.FLOAT);
        me.uvTexture = createDataTextureRGBA(gl, _uvData, gl.RGBA32F, gl.RGBA, gl.FLOAT);
        me.materialTexture = createDataTextureRGBA(gl, new Float32Array(me.dataBuffers.material_buffer), gl.RGBA32F, gl.RGBA, gl.FLOAT);
        me.materialInfoTexture = createDataTextureRGBA(gl, matTexInfoBuffer, gl.RGBA8I, gl.RGBA_INTEGER, gl.BYTE);

        // IBL
        if(gltf.textures.length > 0) {
            const CubeMapSides =
            [
                { name: "right", type: WebGl.context.TEXTURE_CUBE_MAP_POSITIVE_X },
                { name: "left", type: WebGl.context.TEXTURE_CUBE_MAP_NEGATIVE_X },
                { name: "top", type: WebGl.context.TEXTURE_CUBE_MAP_POSITIVE_Y },
                { name: "bottom", type: WebGl.context.TEXTURE_CUBE_MAP_NEGATIVE_Y },
                { name: "front", type: WebGl.context.TEXTURE_CUBE_MAP_POSITIVE_Z },
                { name: "back", type: WebGl.context.TEXTURE_CUBE_MAP_NEGATIVE_Z },
            ];

            let ibl_tex = gltf.textures[gltf.textures.length-2];
            let num_mip_levels = ibl_tex.source.length / 6;
            let res = Math.pow(2, num_mip_levels-1);

            me.envMapTexture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_CUBE_MAP, me.envMapTexture);
           // gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_BASE_LEVEL, 0);
           // gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAX_LEVEL, num_mip_levels);
            gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);

            for(let i=0; i<6; i++) {
                let img = gltf.images[ibl_tex.source[i*num_mip_levels]].image;
                gl.texImage2D(CubeMapSides[i].type, 0, gl.RGB32F, res, res, 0, gl.RGB, gl.FLOAT, img.dataFloat);
            }

            //gl.generateMipmap(gl.TEXTURE_CUBE_MAP);

        }

        me.lastFrameChanged = true;
        me.initShaders();
    }

    this.resizeAccumFramebuffer = function(canvas)
    {
        if (!me.accumTexture)
        {
            if (me.accumTexture) gl.deleteTexture(me.accumTexture);

            me.width = canvas.width;
            me.height = canvas.height;

            console.log("Resizing AccumFramebuffer to " + me.width + "x" + me.height);

            me.accumTexture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, me.accumTexture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, canvas.width, canvas.height, 0, gl.RGBA, gl.FLOAT, null);
            //gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, canvas.width, canvas.height, 0, gl.RGBA, gl.FLOAT, null);
            //gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, canvas.width, canvas.height, 0, gl.RGB, gl.UNSIGNED_BYTE, null);
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.bindFramebuffer(gl.FRAMEBUFFER, me.accumFBO);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, me.accumTexture, 0);
            console.log(gl.checkFramebufferStatus(gl.FRAMEBUFFER));
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }
    }

    this.initShaders = function() {
        let tex_array_shader_snippet = "";
        for(let i =0; i<me.dataBuffers.tex_arrays_glids.length; i++) {
            let id = me.dataBuffers.tex_arrays_glids[i];
            tex_array_shader_snippet += `uniform sampler2DArray u_sampler2DArray_MaterialTextures_${i};\n`
        }

        tex_array_shader_snippet += "\n";
        tex_array_shader_snippet += "vec4 evaluateMaterialTextureValue(const in ivec4 matTexInfo, const in vec2 texCoord) { \n";

        for(let i =0; i<me.dataBuffers.tex_arrays_glids.length; i++) {
            tex_array_shader_snippet += `   if(matTexInfo.x == ${i}) {\n`
            tex_array_shader_snippet += `       return texture(u_sampler2DArray_MaterialTextures_${i}, vec3(texCoord, matTexInfo.y));\n`
            tex_array_shader_snippet += "   }\n";
        }

        if(me.dataBuffers.tex_arrays_glids.length === 0) {
            tex_array_shader_snippet += `       return vec4(1.0);\n`
        }

        tex_array_shader_snippet += "}\n";

        console.log(tex_array_shader_snippet);

        const shaderSources = new Map();
        shaderSources.set("fs.vert", displayVertexShader);
        shaderSources.set("fs.frag", displayFragmentShader);
        shaderSources.set("pt.vert", pathtracingVertexShader);
        shaderSources.set("pt.frag", pathtracingFragmentShader);
        shaderSources.set("material.glsl", tex_array_shader_snippet + materialShader);
        me.shaderCache = new ShaderCache(shaderSources);

        // setup fbo for accumulation
        me.accumFBO = gl.createFramebuffer();
        me.program_Display = me.shaderCache.getShaderProgram( me.shaderCache.selectShader("fs.vert", []), me.shaderCache.selectShader("fs.frag", [])).program;
        let loc_displayTex = gl.getUniformLocation(me.program_Display, "u_sampler2D_ImageToDisplay");
        me.loc_display_u_float_InverseFrameNumber = gl.getUniformLocation(me.program_Display, "u_float_InverseFrameNumber");
        gl.useProgram(me.program_Display);
        gl.uniform1i(loc_displayTex, 0);
        gl.useProgram(null);
        //-------

        me.program_PathTracer = me.shaderCache.getShaderProgram( me.shaderCache.selectShader("pt.frag", []), me.shaderCache.selectShader("pt.vert", [])).program;

        me.positionLocation = gl.getAttribLocation(me.program_PathTracer, "a_position");

        me.tex_array_locations = [];
        for(let i =0; i<me.dataBuffers.tex_arrays_glids.length; i++) {
            let samplerArrayName = `u_sampler2DArray_MaterialTextures_${i}`;
            let loc = gl.getUniformLocation(me.program_PathTracer, samplerArrayName);
            this.tex_array_locations.push(loc);
        }

        me.triangleDataLocation = gl.getUniformLocation(me.program_PathTracer, "u_sampler2D_TriangleData");
        me.normalDataLocation = gl.getUniformLocation(me.program_PathTracer, "u_sampler2D_NormalData");
        me.uvDataLocation = gl.getUniformLocation(me.program_PathTracer, "u_sampler2D_UVData");
        me.materialDataLocation = gl.getUniformLocation(me.program_PathTracer, "u_sampler2D_MaterialData");
        me.materialTexInfoDataLocation = gl.getUniformLocation(me.program_PathTracer, "u_sampler2D_MaterialTexInfoData");
        me.bvhDataLocation = gl.getUniformLocation(me.program_PathTracer, "u_sampler2D_BVHData")
        me.envMapLocation =  gl.getUniformLocation(me.program_PathTracer, "u_samplerCube_EnvMap")

        me.loc_u_vec2_InverseResolution = gl.getUniformLocation(me.program_PathTracer, "u_vec2_InverseResolution");
        me.numTriangleLocation = gl.getUniformLocation(me.program_PathTracer, "u_int_NumTriangles");
        me.frameNumberLocation = gl.getUniformLocation(me.program_PathTracer, "u_int_FrameNumber");
        me.viewMatrixLocation = gl.getUniformLocation(me.program_PathTracer, "u_mat4_ViewMatrix");
        me.cameraPositionLocation = gl.getUniformLocation(me.program_PathTracer, "u_vec3_CameraPosition");

        me.filmHeightLocation = gl.getUniformLocation(me.program_PathTracer, "u_float_FilmHeight");
        me.focalLengthLocation = gl.getUniformLocation(me.program_PathTracer, "u_float_FocalLength");

        me.loc_u_int_MaxTextureSize = gl.getUniformLocation(me.program_PathTracer, "u_int_MaxTextureSize");

        me.loc_u_vec3_PointLightColor = gl.getUniformLocation(me.program_PathTracer, "u_vec3_PointLightColor");
        me.loc_u_vec3_PointLightPosition = gl.getUniformLocation(me.program_PathTracer, "u_vec3_PointLightPosition");
        me.loc_u_float_PointLightIntensity = gl.getUniformLocation(me.program_PathTracer, "u_float_PointLightIntensity");
        me.loc_u_int_MaxBounceDepth = gl.getUniformLocation(me.program_PathTracer, "u_int_MaxBounceDepth");
        //-------

        me.positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        const positions = new Float32Array([-1.0, -1.0, -1.0, 1.0, 1.0, -1.0, 1.0, 1.0]);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

        me.vao = gl.createVertexArray();
        gl.bindVertexArray(me.vao);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

        gl.useProgram(me.program_PathTracer);
        gl.uniform1i(me.triangleDataLocation, 0);
        gl.uniform1i(me.materialDataLocation, 1);
        gl.uniform1i(me.normalDataLocation, 2);
        gl.uniform1i(me.uvDataLocation, 3);
        gl.uniform1i(me.bvhDataLocation, 4);
        gl.uniform1i(me.materialTexInfoDataLocation, 5);
        gl.uniform1i(me.envMapLocation, 6);

        for(let i =0; i<me.tex_array_locations.length; i++) {
            gl.uniform1i(me.tex_array_locations[i], 7+i);
        }

        let max_texture_size = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        gl.uniform1i(me.loc_u_int_MaxTextureSize, max_texture_size);

        gl.useProgram(null);
    }

    me.renderFrame = function(camera, canvas, frameNumber)
    {
        let gl = me.gl;

        me.resizeAccumFramebuffer(canvas);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, me.triangleTexture);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, me.materialTexture);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, me.normalTexture);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, me.uvTexture);
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, me.bvhTexture);
        gl.activeTexture(gl.TEXTURE5);
        gl.bindTexture(gl.TEXTURE_2D, me.materialInfoTexture);
        gl.activeTexture(gl.TEXTURE6);
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, me.envMapTexture);

        for(let i =0; i<this.dataBuffers.tex_arrays_glids.length; i++) {
            gl.activeTexture(gl.TEXTURE0 + i + 7);
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, me.dataBuffers.tex_arrays_glids[i]);
        }

        gl.useProgram(me.program_PathTracer);
        gl.uniform1i(me.numTriangleLocation, me.numTriangles);

        gl.uniformMatrix4fv(me.viewMatrixLocation, false, camera.getViewMatrix(me.gltf));
        gl.uniform1i(me.frameNumberLocation, frameNumber);

        gl.uniform1f(me.filmHeightLocation, Math.tan(camera.yfov*0.5)*camera.znear);
        gl.uniform1f(me.focalLengthLocation, camera.znear);

        let cam_pos = camera.getPosition();
        gl.uniform3f(me.cameraPositionLocation, cam_pos[0], cam_pos[1], cam_pos[2]);

        gl.uniform2f(me.loc_u_vec2_InverseResolution, 1.0 / canvas.width, 1.0 / canvas.height);

        let pointLightPosition = [1.0,1.0,1.0];
        let pointLightColor = [1.0,1.0,1.0];
        let pointLightIntensity = 1.0;

        gl.uniform3f(me.loc_u_vec3_PointLightPosition, pointLightPosition[0], pointLightPosition[1], pointLightPosition[2]);
        gl.uniform3f(me.loc_u_vec3_PointLightColor, pointLightColor[0], pointLightColor[1], pointLightColor[2]);
        gl.uniform1f(me.loc_u_float_PointLightIntensity, pointLightIntensity);

        gl.uniform1i(me.loc_u_int_MaxBounceDepth, 1);

        gl.bindFramebuffer(gl.FRAMEBUFFER, me.accumFBO);
        gl.viewport(0, 0, canvas.width, canvas.height);

        if (frameNumber == 0)
        {
            gl.clearColor(0, 0, 0, 1.0);
            gl.clear(gl.COLOR_BUFFER_BIT);
        }

        gl.blendFunc(gl.ONE, gl.ONE);
        gl.enable(gl.BLEND);

        gl.bindVertexArray(me.vao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.disable(gl.BLEND);
        // gl.clear(gl.COLOR_BUFFER_BIT);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, me.accumTexture);

        gl.blendFunc(gl.ONE, gl.ONE);
        gl.enable(gl.BLEND);

        gl.disable(gl.CULL_FACE);
        gl.disable(gl.DEPTH_TEST);
        gl.useProgram(me.program_Display);
        let invFrameNumber = 1.0 / (frameNumber + 1.0);
        //console.log(invFrameNumber);
        gl.uniform1f(me.loc_display_u_float_InverseFrameNumber, invFrameNumber);
        gl.uniform1i(me.loc_displayTex, 0);
        gl.bindVertexArray(me.vao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    }
}

class PathtracingRenderer
{
    constructor(canvas, defaultCamera, parameters, basePath)
    {
        this.canvas = canvas;
        this.defaultCamera = defaultCamera;
        this.parameters = parameters;
        this.basePath = basePath;
        this.shader = undefined; // current shader

        this.currentWidth = 0;
        this.currentHeight = 0;

        let requiredWebglExtensions = [
            "EXT_color_buffer_float",
            "EXT_texture_filter_anisotropic",
        ];

        WebGl.loadWebGlExtensions(requiredWebglExtensions);
        // use shader lod ext if requested and supported
        this.parameters.useShaderLoD = this.parameters.useShaderLoD && WebGl.context.getExtension("EXT_shader_texture_lod") !== null;

        this.visibleLights = [];

        this.viewMatrix = mat4.create();
        this.projMatrix = mat4.create();
        this.viewProjectionMatrix = mat4.create();

        this.currentCameraPosition = vec3.create();

        this.init();
        this.resize(canvas.clientWidth, canvas.clientHeight);

        this.glslRaytracer = new GLSLRaytracer(WebGl, defaultCamera, canvas);
        this.frame_number = 0;
    }

    /////////////////////////////////////////////////////////////////////
    // Render glTF scene graph
    /////////////////////////////////////////////////////////////////////

    // app state
    init()
    {
        // if (!this.parameters.useShaderLoD)
        // {
        //     this.parameters.useIBL = false;
        //     this.parameters.usePunctual = true;
        // }

        //TODO: To achieve correct rendering, WebGL runtimes must disable such conversions by setting UNPACK_COLORSPACE_CONVERSION_WEBGL flag to NONE
        WebGl.context.disable(WebGl.context.DEPTH_TEST);
        // WebGl.context.disable(WebGl.context.CULL_FACE);
        WebGl.context.colorMask(true, true, true, true);
        //WebGl.context.clearDepth(1.0);
        WebGl.context.clearColor(this.parameters.clearColor[0] / 255.0, this.parameters.clearColor[1] / 255.0, this.parameters.clearColor[2] / 255.0, 1.0);
        WebGl.context.clear(WebGl.context.COLOR_BUFFER_BIT);
    }

    resize(width, height)
    {
        if (this.currentWidth !== width || this.currentHeight !== height)
        {
            this.canvas.width = width;
            this.canvas.height = height;
            this.currentHeight = height;
            this.currentWidth = width;
            WebGl.context.viewport(0, 0, width, height);
        }
    }

    // frame state
    newFrame()
    {
        // WebGl.context.clearColor(this.parameters.clearColor[0] / 255.0, this.parameters.clearColor[1] / 255.0, this.parameters.clearColor[2]  / 255.0, 1.0);
        // WebGl.context.clear(WebGl.context.COLOR_BUFFER_BIT);// | WebGl.context.DEPTH_BUFFER_BIT);
    }

    drawScene(gltf, scene, sortByDepth, predicateDrawPrimivitve)
    {
        let currentCamera = undefined;
        if (!this.parameters.userCameraActive())
        {
            currentCamera = gltf.cameras[this.parameters.cameraIndex].clone();
        }
        else
        {
            currentCamera = this.defaultCamera;
        }

        currentCamera.aspectRatio = this.currentWidth / this.currentHeight;

        if (this.glslRaytracer.lastFrameChanged)
        {
            this.frame_number = 0;
            this.glslRaytracer.lastFrameChanged = false;
        }

        this.glslRaytracer.renderFrame(currentCamera, this.canvas, this.frame_number);
        this.frame_number++;
    }

    // returns all lights that are relevant for rendering or the default light if there are none
    getVisibleLights(gltf, scene)
    {
        // let lights = [];
        // for (let light of gltf.lights)
        // {
        //     if (light.node !== undefined)
        //     {
        //         if (scene.includesNode(gltf, light.node))
        //         {
        //             lights.push(light);
        //         }
        //     }
        // }
        // return lights.length > 0 ? lights : [ new gltfLight() ];
    }

    updateSkin(gltf, node)
    {
        // if(this.parameters.skinning && gltf.skins !== undefined) // && !this.parameters.animationTimer.paused
        // {
        //     const skin = gltf.skins[node.skin];
        //     skin.computeJoints(gltf, node);
        // }
    }

    pushVertParameterDefines(vertDefines, gltf, node, primitive)
    {
        // // skinning
        // if(this.parameters.skinning && node.skin !== undefined && primitive.hasWeights && primitive.hasJoints)
        // {
        //     const skin = gltf.skins[node.skin];

        //     vertDefines.push("USE_SKINNING 1");
        //     vertDefines.push("JOINT_COUNT " + skin.jointMatrices.length);
        // }

        // // morphing
        // if(this.parameters.morphing && node.mesh !== undefined && primitive.targets.length > 0)
        // {
        //     const mesh = gltf.meshes[node.mesh];
        //     if(mesh.weights !== undefined && mesh.weights.length > 0)
        //     {
        //         vertDefines.push("USE_MORPHING 1");
        //         vertDefines.push("WEIGHT_COUNT " + Math.min(mesh.weights.length, 8));
        //     }
        // }
    }

    updateAnimationUniforms(gltf, node, primitive)
    {
        // if(this.parameters.skinning && node.skin !== undefined && primitive.hasWeights && primitive.hasJoints)
        // {
        //     const skin = gltf.skins[node.skin];

        //     this.shader.updateUniform("u_jointMatrix", skin.jointMatrices);
        //     this.shader.updateUniform("u_jointNormalMatrix", skin.jointNormalMatrices);
        // }

        // if(this.parameters.morphing && node.mesh !== undefined && primitive.targets.length > 0)
        // {
        //     const mesh = gltf.meshes[node.mesh];
        //     if(mesh.weights !== undefined && mesh.weights.length > 0)
        //     {
        //         this.shader.updateUniformArray("u_morphWeights", mesh.weights);
        //     }
        // }
    }

    pushFragParameterDefines(fragDefines)
    {
        // if (this.parameters.usePunctual)
        // {
        //     fragDefines.push("USE_PUNCTUAL 1");
        //     fragDefines.push("LIGHT_COUNT " + this.visibleLights.length);
        // }

        // if (this.parameters.useIBL)
        // {
        //     fragDefines.push("USE_IBL 1");
        // }

        // if(this.parameters.useShaderLoD)
        // {
        //     fragDefines.push("USE_TEX_LOD 1");
        // }

        // if (Environments[this.parameters.environmentName].type === ImageMimeType.HDR)
        // {
        //     fragDefines.push("USE_HDR 1");
        // }

        // switch(this.parameters.toneMap)
        // {
        // case(ToneMaps.UNCHARTED):
        //     fragDefines.push("TONEMAP_UNCHARTED 1");
        //     break;
        // case(ToneMaps.HEJL_RICHARD):
        //     fragDefines.push("TONEMAP_HEJLRICHARD 1");
        //     break;
        // case(ToneMaps.ACES):
        //     fragDefines.push("TONEMAP_ACES 1");
        //     break;
        // case(ToneMaps.LINEAR):
        // default:
        //     break;
        // }

        // if(this.parameters.debugOutput !== DebugOutput.NONE)
        // {
        //     fragDefines.push("DEBUG_OUTPUT 1");
        // }

        // switch(this.parameters.debugOutput)
        // {
        // case(DebugOutput.METALLIC):
        //     fragDefines.push("DEBUG_METALLIC 1");
        //     break;
        // case(DebugOutput.ROUGHNESS):
        //     fragDefines.push("DEBUG_ROUGHNESS 1");
        //     break;
        // case(DebugOutput.NORMAL):
        //     fragDefines.push("DEBUG_NORMAL 1");
        //     break;
        // case(DebugOutput.BASECOLOR):
        //     fragDefines.push("DEBUG_BASECOLOR 1");
        //     break;
        // case(DebugOutput.OCCLUSION):
        //     fragDefines.push("DEBUG_OCCLUSION 1");
        //     break;
        // case(DebugOutput.EMISIVE):
        //     fragDefines.push("DEBUG_EMISSIVE 1");
        //     break;
        // case(DebugOutput.F0):
        //     fragDefines.push("DEBUG_F0 1");
        //     break;
        // case(DebugOutput.ALPHA):
        //     fragDefines.push("DEBUG_ALPHA 1");
        //     break;
        // }
    }

    applyLights(gltf)
    {
        // let uniformLights = [];
        // for (let light of this.visibleLights)
        // {
        //     uniformLights.push(light.toUniform(gltf));
        // }

        // this.shader.updateUniform("u_Lights", uniformLights);
    }

    applyEnvironmentMap(gltf, texSlotOffset)
    {
        // if (gltf.envData === undefined)
        // {
        //     let linear = true;
        //     if (Environments[this.parameters.environmentName].type !== ImageMimeType.HDR)
        //     {
        //         linear = false;
        //     }

        //     gltf.envData = {};
        //     gltf.envData.diffuseEnvMap = new gltfTextureInfo(gltf.textures.length - 3, 0, linear);
        //     gltf.envData.specularEnvMap = new gltfTextureInfo(gltf.textures.length - 2, 0, linear);
        //     gltf.envData.lut = new gltfTextureInfo(gltf.textures.length - 1);
        //     gltf.envData.specularEnvMap.generateMips = false;
        //     gltf.envData.lut.generateMips = false;
        // }

        // WebGl.setTexture(this.shader.getUniformLocation("u_DiffuseEnvSampler"), gltf, gltf.envData.diffuseEnvMap, texSlotOffset);
        // WebGl.setTexture(this.shader.getUniformLocation("u_SpecularEnvSampler"), gltf, gltf.envData.specularEnvMap, texSlotOffset + 1);
        // WebGl.setTexture(this.shader.getUniformLocation("u_brdfLUT"), gltf, gltf.envData.lut, texSlotOffset + 2);

        // const mipCount = Environments[this.parameters.environmentName].mipLevel;
        // this.shader.updateUniform("u_MipCount", mipCount);
    }

    destroy()
    {
        this.shaderCache.destroy();
    }
}

export { PathtracingRenderer };
