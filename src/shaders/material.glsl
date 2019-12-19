uniform sampler2D u_sampler2D_MaterialData;
uniform isampler2D u_sampler2D_MaterialTexInfoData;

struct MaterialData {
	vec4 albedo;
    float metallic;
	float roughness;
    float normalScale;
    float emissionFactor;
    vec3 specularTint;
    float specular;
};
const int materialSize = 3;

struct MaterialTextureInfo {
    ivec4 albedo; //[texArrayIdx, texIdx, uvSet, xxx]
    ivec4 occlusionMetallicRoughness;
    ivec4 normal;
    ivec4 emission;
    ivec4 specular;
};
const int materialTexInfoSize = 5;

ivec2 getStructParameterTexCoord(int structIdx, int paramIdx, int structStride) {
    return ivec2(
        (structIdx*structStride + paramIdx) % u_int_MaxTextureSize,
        (structIdx*structStride + paramIdx) / u_int_MaxTextureSize
    );
}

void getMaterialData_(in int idx, out MaterialData matData) {
    ivec2 albedoIdx = getStructParameterTexCoord(idx, 0, materialSize);
    ivec2 mrneIdx = getStructParameterTexCoord(idx, 1, materialSize);
    ivec2 specularIdx = getStructParameterTexCoord(idx, 2, materialSize);

    matData.albedo = texelFetch(u_sampler2D_MaterialData, albedoIdx, 0);
    vec4 mrne = texelFetch(u_sampler2D_MaterialData, mrneIdx, 0);
    vec4 specular = texelFetch(u_sampler2D_MaterialData, specularIdx, 0);

    matData.metallic = mrne.x;
    matData.roughness = mrne.y;
    matData.normalScale = mrne.z;
    matData.emissionFactor = mrne.w;
    matData.specular = specular.w;
    matData.specularTint = specular.xyz;
}

void getMaterialTexInfo(in int idx, out MaterialTextureInfo matTexInfo) {
    ivec2 albedoTexInfoIdx = getStructParameterTexCoord(idx, 0, materialTexInfoSize);
    ivec2 metallicRoughnessTexInfoIdx = getStructParameterTexCoord(idx, 1, materialTexInfoSize);
    ivec2 normalTexInfoIdx = getStructParameterTexCoord(idx, 2, materialTexInfoSize);
    ivec2 emissionTexInfoIdx = getStructParameterTexCoord(idx, 3, materialTexInfoSize);
    ivec2 specularTexInfoIdx = getStructParameterTexCoord(idx, 4, materialTexInfoSize);

    matTexInfo.albedo = ivec4(texelFetch(u_sampler2D_MaterialTexInfoData, albedoTexInfoIdx, 0));
    matTexInfo.occlusionMetallicRoughness = ivec4(texelFetch(u_sampler2D_MaterialTexInfoData, metallicRoughnessTexInfoIdx, 0));
    matTexInfo.normal = ivec4(texelFetch(u_sampler2D_MaterialTexInfoData, normalTexInfoIdx, 0));
    matTexInfo.emission = ivec4(texelFetch(u_sampler2D_MaterialTexInfoData, emissionTexInfoIdx, 0));
    matTexInfo.specular = ivec4(texelFetch(u_sampler2D_MaterialTexInfoData, specularTexInfoIdx, 0));
}


struct MaterialClosure {
    vec4 albedo;
    float metallic;
    float roughness;
    vec3 emission;
    vec3 normal;
};

void calculateMaterialClosure(const in int matIdx, const in vec2 uv, const in mat3 onb, out MaterialClosure closure, out vec3 shadingNormal) {
    MaterialData matData;
    MaterialTextureInfo matTexInfo;

    getMaterialData_(matIdx, matData);
    getMaterialTexInfo(matIdx, matTexInfo);

    closure.albedo = matData.albedo * evaluateMaterialTextureValue(matTexInfo.albedo, uv);
    vec4 occlusionMetallicRoughness = evaluateMaterialTextureValue(matTexInfo.occlusionMetallicRoughness, uv);
    closure.metallic *= matData.metallic * occlusionMetallicRoughness.y;
    closure.roughness *= matData.roughness * occlusionMetallicRoughness.z;
    vec4 specular = evaluateMaterialTextureValue(matTexInfo.specular, uv);
    specular.w *= matData.specular;

    if(matTexInfo.normal.y >= 0)
        shadingNormal = matData.normalScale * onb * normalize(evaluateMaterialTextureValue(matTexInfo.normal, uv).xyz * 2.0 - vec3(1.0));

    closure.emission = evaluateMaterialTextureValue(matTexInfo.emission, uv).xyz;// * matData.emissionFactor;
}

