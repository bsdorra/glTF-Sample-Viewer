precision highp float;
precision highp sampler2DArray;
precision highp sampler2D;
precision lowp isampler2D;

uniform int u_int_MaxTextureSize; // used for data acessing of linear data in 2d textures
#include <material.glsl>

in vec2 v_PixelCoord;

uniform float u_float_FilmHeight;
uniform float u_float_FocalLength;
uniform vec3 u_vec3_CameraPosition;
uniform vec2 u_vec2_InverseResolution;
uniform mat4 u_mat4_ViewMatrix;
uniform int u_int_NumTriangles;

uniform int u_int_FrameNumber;


uniform sampler2D u_sampler2D_TriangleData;
uniform sampler2D u_sampler2D_BVHData;
uniform sampler2D u_sampler2D_NormalData;
uniform sampler2D u_sampler2D_UVData;
uniform samplerCube u_samplerCube_EnvMap;

out vec4 outColor;

// our global RNG state
uvec2 rng_state;
uint george_marsaglia_rng() {
    rng_state.x = 36969u * (rng_state.x & 65535u) + (rng_state.x >> 16u);
    rng_state.y = 18000u * (rng_state.y & 65535u) + (rng_state.y >> 16u);
    return (rng_state.x << 16u) + rng_state.y;
}

float rng_NextFloat() {
    return float(george_marsaglia_rng()) / float(0xFFFFFFFFu);
}

void init_RNG() {
    vec2 offset = vec2(u_int_FrameNumber*17,0.0);

    //Initialize RNG
    rng_state = uvec2(397.6432*(gl_FragCoord.xy+offset));
    rng_state ^= uvec2(32.9875*(gl_FragCoord.yx+offset));
}

const float PI = 3.1415926535897932384626;
const float INV_PI = 1.0 / PI;

vec3 hemisphereSample_cos(float u, float v) {
     float phi = v * 2.0 * PI;
     float cosTheta = sqrt(1.0 - u);
     float sinTheta = sqrt(1.0 - cosTheta * cosTheta);
     return vec3(cos(phi) * sinTheta, sin(phi) * sinTheta, cosTheta);
 }

// !!TODO: try newer/improved methods here (but check also performance)
void frisvad(const in vec3 n, out vec3 b1, out vec3 b2) {
    if(n.z < -0.9999999) { // Handle the singularity
        b1 = vec3(0.0, -1.0, 0.0);
        b2 = vec3(-1.0, 0.0, 0.0);
        return;
    }
    float a = 1.0 / (1.0 + n.z);
    float b = -n.x*n.y*a;
    b1 = vec3(1.0f - n.x*n.x*a, b, -n.x);
    b2 = vec3(b, 1.0f - n.y*n.y*a, -n.y);
}

mat3 computeONB(const in vec3 n) {
    mat3 ret;
    ret[2] = n;
    frisvad(n, ret[0], ret[1]);
    return ret;
}

struct Ray {
    vec3 direction;
    vec3 origin;
    float tfar;
    vec3 inv_direction;
    ivec3 sign;
};

Ray createRay(in vec3 direction, in vec3 origin, in float tfar) {
    vec3 inv_direction = vec3(1.0) / direction;

    return Ray(
        direction,
        origin,
        tfar,
        inv_direction,
        ivec3((inv_direction.x < 0.0) ? 1 : 0,
         (inv_direction.y < 0.0) ? 1 : 0,
         (inv_direction.z < 0.0) ? 1 : 0)
    );
}

bool intersectAABB(const in Ray ray, const in vec3 aabb[2], out float tmin, out float tmax) {
    float tymin, tymax, tzmin, tzmax;
    tmin = (aabb[ray.sign[0]].x - ray.origin.x) * ray.inv_direction.x;
    tmax = (aabb[1-ray.sign[0]].x - ray.origin.x) * ray.inv_direction.x;
    tymin = (aabb[ray.sign[1]].y - ray.origin.y) * ray.inv_direction.y;
    tymax = (aabb[1-ray.sign[1]].y - ray.origin.y) * ray.inv_direction.y;
    tzmin = (aabb[ray.sign[2]].z - ray.origin.z) * ray.inv_direction.z;
    tzmax = (aabb[1-ray.sign[2]].z - ray.origin.z) * ray.inv_direction.z;
    tmin = max(max(tmin, tymin), tzmin);
    tmax = min(min(tmax, tymax), tzmax);
    return (tmin <= tmax); // we have an intersection; no intersection if tmin > tmax
}


const float EPSILON  = 1e-6;
// std. moeller trumbore triangle intersection test
bool intersectTriangle(const in Ray r, const in mat3 triangle, const in float tfar, out float t, out vec2 uv) {
    vec3 e0 = triangle[1] - triangle[0];
    vec3 e1 = triangle[2] - triangle[0];
    vec3 pvec = cross(r.direction, e1);
    float det = dot(e0, pvec);
    if(abs(det) < EPSILON) // intersect backfaces
    //if(a < EPSILON) // skip backfaces
        return false;
    float f = 1.0 / det;
    vec3  s = r.origin - triangle[0];
    float u = f * dot(s, pvec);

    if(u < 0.0 || u > 1.0)
        return false;

    vec3  qvec = cross(s, e0);
    float v = f * dot(r.direction, qvec);
    if(v < 0.0 || u + v > 1.0)
        return false;
    t = f * dot(e1, qvec);

    if (t < EPSILON)
        return false;

    uv = vec2(u, v);
    return (t > 0.0) && (t < tfar);
}

vec3 computeTriangleNormal(const in mat3 triangle) {
    vec3 e0 = triangle[1] - triangle[0];
    vec3 e1 = triangle[2] - triangle[0];
    return normalize(cross(e1, e0));
}

struct HitInfo {
    int triIndex;
    float tfar;
    vec2 uv;
};

struct RenderState {
    vec3 hitPoint;
    vec3 geometryNormal;
    mat3 shadingONB;
    mat3 interpolatedONB;
    vec3 outDir; // direction towards camera
    vec3 inDir;  // direction towrads light/bounce
    vec2 uv0;
    vec2 uv1;
    MaterialClosure closure;
};


int getMaterialIndex(const in int triIndex) {
     int idx_x0 = (triIndex*3 + 0) % u_int_MaxTextureSize;
     int idx_y0 = (triIndex*3 + 0) / u_int_MaxTextureSize;

     return int(texelFetch(u_sampler2D_TriangleData, ivec2(idx_x0, idx_y0), 0).w);
}

mat3 getSceneTriangle(const in int index) {
    ivec2 idx0 = getStructParameterTexCoord(index, 0, 3);
    ivec2 idx1 = getStructParameterTexCoord(index, 1, 3);
    ivec2 idx2 = getStructParameterTexCoord(index, 2, 3);

    mat3 triangle;
    triangle[0] = texelFetch(u_sampler2D_TriangleData, idx0, 0).xyz;
    triangle[1] = texelFetch(u_sampler2D_TriangleData, idx1, 0).xyz;
    triangle[2] = texelFetch(u_sampler2D_TriangleData, idx2, 0).xyz;

    return triangle;
}

vec3 calculateInterpolatedNormal(const in int index, const in vec2 uv) {
    ivec2 idx0 = getStructParameterTexCoord(index, 0, 3);
    ivec2 idx1 = getStructParameterTexCoord(index, 1, 3);
    ivec2 idx2 = getStructParameterTexCoord(index, 2, 3);

    mat3 normals;
    normals[0] = texelFetch(u_sampler2D_NormalData, idx0, 0).xyz;
    normals[1] = texelFetch(u_sampler2D_NormalData, idx1, 0).xyz;
    normals[2] = texelFetch(u_sampler2D_NormalData, idx2, 0).xyz;

    return normalize((1.0 - uv.x - uv.y) * normals[0] + uv.x * normals[1] + uv.y * normals[2]);
}


vec2 calculateInterpolatedUV(const in int index, const in vec2 hit_uv, int set) {
    ivec2 idx0 = getStructParameterTexCoord(index, 0, 3);
    ivec2 idx1 = getStructParameterTexCoord(index, 1, 3);
    ivec2 idx2 = getStructParameterTexCoord(index, 2, 3);

    vec2 uv0, uv1, uv2;
    if(set == 0) {
        uv0 = texelFetch(u_sampler2D_UVData, idx0, 0).xy;
        uv1 = texelFetch(u_sampler2D_UVData, idx1, 0).xy;
        uv2 = texelFetch(u_sampler2D_UVData, idx2, 0).xy;
    } else {
        uv0 = texelFetch(u_sampler2D_UVData, idx0, 0).zw;
        uv1 = texelFetch(u_sampler2D_UVData, idx1, 0).zw;
        uv2 = texelFetch(u_sampler2D_UVData, idx2, 0).zw;
    }

    return (1.0 - hit_uv.x - hit_uv.y) * uv0 + hit_uv.x * uv1 + hit_uv.y * uv2;
}


bool bvh_IntersectRayBox(const in Ray r, const in float tfar, int pn, out int si, out int ei) {
    int idx_x0 = (pn*2+0) % u_int_MaxTextureSize;
    int idx_y0 = (pn*2+0) / u_int_MaxTextureSize;

    int idx_x1 = (pn*2+1) % u_int_MaxTextureSize;
    int idx_y1 = (pn*2+1) / u_int_MaxTextureSize;

    vec4 nodeA = texelFetch(u_sampler2D_BVHData, ivec2(idx_x0, idx_y0), 0);
    vec4 nodeB = texelFetch(u_sampler2D_BVHData, ivec2(idx_x1, idx_y1), 0);
    vec3 aabb[2];
    aabb[0] = nodeA.xyz;
    aabb[1] = nodeB.xyz;
    si = int(nodeA.w);
    ei = int(nodeB.w);

    float tmin, tmax;
    bool hasHit = intersectAABB(r, aabb, tmin, tmax);
    return hasHit && ((tmin <= tfar) || (tmin < 0.0 && tmax <= tfar));


    //!!TODO: check if this has correct semantics for rays that start inside the box?
    //return hasHit && ((/*tmin > 0.0 && */tmin <= tfar) || (tmin < 0.0 && tmax <= tfar));
}


/*!!TODO/!!TOOPT:
    - sort out the many tfars
    - sort the needed data in ray payload and return values
*/
bool intersectSceneTriangles_BVH(const in Ray r, out HitInfo hit) {
    hit.tfar = r.tfar;
    hit.triIndex = -1;

    int stack[16];
    int top = 1;
    int pn = 0;

    float tfar = r.tfar;
    bool foundHit = false;
    int si, ei;

    while (top > 0) {
        if (bvh_IntersectRayBox(r, tfar, pn, si, ei)) {

            if (si > 0) { // intermediate node
                // !!TOOPT: sort front to back based on ray sign (but this needs additional data in nodes based on construction)
                pn = si;
                stack[top++] = ei;
            } else { // leaf node
                for (int i = -si; i < -ei; i++) {
                    float t = 0.0;
                    vec2 uv;
                    mat3 triangle = getSceneTriangle(i);
                    if (intersectTriangle(r, triangle, hit.tfar, t, uv)) {
                        hit.tfar = t;
                        hit.triIndex = i;
                        hit.uv = uv;
                        foundHit = true;
                        tfar = t;
                    }
                }

                pn = stack[--top];
            }

        } else {
            pn = stack[--top];
        }
    }

    return foundHit;
}

bool intersectSceneTriangles_Bruteforce(const in Ray r, out HitInfo hit) {
    hit.tfar = r.tfar;
    hit.triIndex = -1;

    for (int i = 0; i < u_int_NumTriangles; i++) {
        mat3 triangle = getSceneTriangle(i);

        float t = 0.0;
        vec2 uv;
        if (intersectTriangle(r, triangle, hit.tfar, t, uv)) {
            hit.tfar = t;
            hit.triIndex = i;
            hit.uv = uv;
        } else {
        }
    }

    return hit.triIndex >= 0;
}

bool intersectScene_Nearest(const in Ray r, out HitInfo hit) {
    //return intersectSceneTriangles_Bruteforce(r, hit);
    return intersectSceneTriangles_BVH(r, hit);
}

bool isVisible(const in vec3 p0, const in vec3 p1) {
    //Ray r = createRay(p1-p0, p0, 1.0);
    Ray r = createRay(normalize(p1-p0), p0, length(p1-p0));

    HitInfo hit;
    return !intersectScene_Nearest(r, hit); //!!TOOPT: add an early hit function here

    /*
    for (int i = 0; i < u_int_NumTriangles; i++) {
        mat3 triangle = getSceneTriangle(i);
        float t = 0.0;
        vec2 uv;
        if (intersectTriangle(r, triangle, r.tfar, t, uv)) {
            return false;
        }
    }

    return true;
    */
}


void fillRenderState(const in Ray r, const in HitInfo hit, out RenderState rs) {
    rs.uv0 = calculateInterpolatedUV(hit.triIndex, hit.uv, 0);
    rs.uv1 = calculateInterpolatedUV(hit.triIndex, hit.uv, 1);

    rs.geometryNormal = computeTriangleNormal(getSceneTriangle(hit.triIndex));
    rs.geometryNormal *= -sign(dot(rs.geometryNormal, r.direction));

    vec3 interpolatedNormal = calculateInterpolatedNormal(hit.triIndex, hit.uv);
    rs.interpolatedONB = computeONB(interpolatedNormal);

    int matIdx = getMaterialIndex(hit.triIndex);
    calculateMaterialClosure(matIdx, rs.uv0, rs.interpolatedONB, rs.closure, interpolatedNormal);

    rs.shadingONB = computeONB(interpolatedNormal);

    rs.hitPoint = r.origin + r.direction * hit.tfar + rs.geometryNormal*0.0001;
    rs.outDir = -r.direction;
}

const float TFAR_MAX = 10000.0;


vec3 brdf_lambert_evaluate(out float o_pdf, const in RenderState rs, const in vec3 wi) {
    o_pdf = max(dot(wi, rs.shadingONB[2]), 0.0) * INV_PI;
    return rs.closure.albedo.xyz * INV_PI;
}

bool brdf_lambert_sample(out vec3 wi, const in RenderState rs) {
    wi = rs.shadingONB * hemisphereSample_cos(rng_NextFloat(), rng_NextFloat());
    return true;
}

vec3 brdf_mirror_evaluate(out float o_pdf, const in RenderState rs, const in vec3 wi) {
    o_pdf = 0.0;
    return rs.closure.albedo.xyz;
}

bool brdf_mirror_sample(out vec3 wi, const in RenderState rs) {
    wi = -reflect(rs.outDir, rs.shadingONB[2]);
    return true;
}


vec3 brdf_phong_evaluate(out float o_pdf, const in RenderState rs, in vec3 wi) {
    float cos_NI = dot(rs.shadingONB[2], wi);
    float cos_NO = dot(rs.shadingONB[2], rs.outDir);

    float exponent = rs.closure.roughness * 510.0;

    if (cos_NI > 0.0 && cos_NO > 0.0) {
        vec3 R = -reflect(rs.outDir, rs.shadingONB[2]);
        float cosRI = dot(R, wi);
        if (cosRI > 0.0) {
            o_pdf = (exponent + 1.0) * float(INV_PI / 2.0) * pow(cosRI, exponent);
            return rs.closure.albedo.xyz * cos_NI * (exponent + 2.0) / (exponent + 1.0);
        }
    }
    o_pdf = 0.0;
    return vec3(0.0);
}

bool brdf_phong_sample(out vec3 wi, const in RenderState rs) {
    float cos_NO = dot(rs.shadingONB[2], rs.outDir);
    float exponent = rs.closure.roughness * 510.0;
    if (cos_NO > 0.0) {
        float rx = rng_NextFloat();
        float ry = rng_NextFloat();
        mat3 onb = computeONB(-reflect(rs.outDir, rs.shadingONB[2]));
        float phi = 2.0 * PI * rx;
        float sp = sin(phi);
        float cp = cos(phi);
        float cosTheta = pow(ry, 1.0 / (exponent + 1.0));
        float sinTheta2 = 1.0 - cosTheta * cosTheta;
        float sinTheta = (sinTheta2 > 0.0) ? sqrt(sinTheta2) : 0.0;
        wi = onb * vec3(cp * sinTheta, sp * sinTheta, cosTheta);
        float cos_NI = dot(rs.shadingONB[2], wi);
        if (cos_NI > 0.0) {
            return true;
            //return cos_NI * (exponent + 2.0) / (exponent + 1.0);
        }
    }
    return false;
}



int sampleBSDFBounce(inout RenderState rs, inout vec3 pathWeight) {
    float pdf = 0.0;
    if (rs.closure.roughness == 0.0) {
        if (brdf_lambert_sample(rs.inDir, rs)) {
            pathWeight *= brdf_lambert_evaluate(pdf, rs, rs.inDir);
        } else return -1;
    } else if (rs.closure.roughness < 1.0) {
        if (brdf_phong_sample(rs.inDir, rs)) {
            pathWeight *= brdf_phong_evaluate(pdf, rs, rs.inDir);
        } else return -1;
    } else {
        if (brdf_mirror_sample(rs.inDir, rs)) {
            pathWeight *= brdf_mirror_evaluate(pdf, rs, rs.inDir);
        } else return -1;
    }

    Ray r = createRay(rs.inDir, rs.hitPoint, TFAR_MAX);
    HitInfo hit;

    if (intersectScene_Nearest(r, hit)) {
        fillRenderState(r, hit, rs);
        return 1;
    }

    return 0;
}

uniform vec3 u_vec3_PointLightColor;
uniform vec3 u_vec3_PointLightPosition;
uniform float u_float_PointLightIntensity;

uniform int u_int_MaxBounceDepth;

vec3 sampleAndEvaluateDirectLight(const in RenderState rs) {
    vec3 pointLightColor = u_vec3_PointLightColor * u_float_PointLightIntensity;
    float pdf = 0.0;
    if (rs.closure.roughness < 0.9) {
        vec3 d = u_vec3_PointLightPosition - rs.hitPoint;
        float cosNL = dot(d, rs.shadingONB[2]);

        if (cosNL > 0.0) {
            if (isVisible(rs.hitPoint, u_vec3_PointLightPosition)) {
                float distance2 = dot(d, d);
                d = normalize(d);

                if (rs.closure.roughness == 0.0) {
                    return brdf_lambert_evaluate(pdf, rs, d) * (pointLightColor / distance2);
                } /*else {
                    return brdf_phong_evaluate(pdf, rs, d) * (pointLightColor / distance2);
                }*/
            }
        }
    } else { // singular

    }

    return vec3(0.0);
}

void main() {
    init_RNG();

    // box filter
    vec2 pixelOffset = (vec2(rng_NextFloat(), rng_NextFloat()) * 2.0) * u_vec2_InverseResolution;

    float ratio = u_vec2_InverseResolution.y / u_vec2_InverseResolution.x;
    vec3 pixelDirection = normalize(vec3((v_PixelCoord*vec2(ratio, 1.0) + pixelOffset)*u_float_FilmHeight, -u_float_FocalLength));

    pixelDirection = pixelDirection * mat3(u_mat4_ViewMatrix); // transposed mult == inverse
    vec3 origin = u_vec3_CameraPosition;

    Ray r = createRay(pixelDirection, origin, TFAR_MAX);
    HitInfo hit;

    vec3 pathWeight = vec3(1.0);
    vec3 colorAccum = vec3(0.0);

    if (intersectScene_Nearest(r, hit)) { // primary camera ray
        RenderState rs;
        fillRenderState(r, hit, rs);

        colorAccum += rs.closure.emission;// + pathWeight * sampleAndEvaluateDirectLight(rs);
        for (int depth = 0; depth < u_int_MaxBounceDepth; depth++) {
            int bounceType = sampleBSDFBounce(rs, pathWeight);

            if (bounceType == -1) { // absorbed
            }
            if (bounceType == 0) { // background
                colorAccum += texture(u_samplerCube_EnvMap, rs.inDir).xyz * pathWeight;
                break;
            }
            colorAccum += rs.closure.emission;
            //colorAccum += pathWeight * sampleAndEvaluateDirectLight(rs);
        }

        //colorAccum = texture(u_samplerCube_EnvMap, reflect(-r.direction, rs.shadingONB[2])).xyz;
        //colorAccum = rs.shadingONB[2];
        //colorAccum = rs.closure.albedo.xyz;
        //colorAccum = vec3(rs.uv0, 0.0);
    } else { // direct background hit
        colorAccum =  texture(u_samplerCube_EnvMap, r.direction).xyz;
    }


    outColor = vec4(colorAccum, 1.0);

    //outColor = vec4(1.0, 0.0, 0.0, 1.0);
    //outColor = vec4(vec3(hit.tfar), 1.0);
    //outColor = vec4(rng_NextFloat(), rng_NextFloat(), 0.0, 1.0);
    //outColor = texture(u_sampler2D_TriangleData, vec2(0.0, 0.0));
    //outColor = texelFetch(u_sampler2D_TriangleData, ivec2(0, 0), 0);
}
